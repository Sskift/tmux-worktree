import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { NewTerminalModal } from "./NewTerminalModal";
import { ThemePicker } from "./ThemePicker";
import { GitStatusPanel } from "./GitStatusPanel";
import { FileTree } from "./FileTree";
import { FileEditor } from "./FileEditor";
import { DiffViewer } from "./DiffViewer";
import { AutomationPanel } from "./AutomationPanel";
import { useSortable } from "./useSortable";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
import {
  automationFromRecord,
  automationRunFromRecord,
  automationSaveInputFromDraft,
  createAutomationDraft,
  shouldRunAutomationSchedule,
  triggerLabel,
  type Automation,
  type AutomationDraft,
  type AutomationRecord,
  type AutomationRun,
  type AutomationRunRecord,
} from "./automationTypes";
import {
  SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
  SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
  SIDEBAR_GIT_MIN_HEIGHT,
  SIDEBAR_TERMINALS_MIN_HEIGHT,
  SIDEBAR_WORKTREES_MIN_HEIGHT,
  normalizeSidebarSplits,
} from "./sidebarLayout";
import "./App.css";

type Session = {
  name: string;
  attached: boolean;
  window_count: number;
  created: number;
  activity: number;
};

type PlainTerminal = {
  id: string;
  label: string;
  cwd: string;
  tmuxName: string;
};

type Selection =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string }
  | { kind: "automation"; id: string }
  | null;

type WindowLayout = {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
};

const REFRESH_MS = 2000;
const WINDOW_DEFAULTS = { width: 1440, height: 900 };

const PROJECT_COLORS = [
  "#f687b3",
  "#9ae6b4",
  "#f6ad55",
  "#90cdf4",
  "#d6bcfa",
  "#81e6d9",
  "#fbd38d",
  "#feb2b2",
  "#9ae6b4",
  "#b794f6",
];

function projectKey(name: string): string {
  const i = name.indexOf("-");
  return i > 0 ? name.slice(0, i) : name;
}

function colorForProject(map: Map<string, string>, project: string): string {
  if (!map.has(project)) {
    map.set(project, PROJECT_COLORS[map.size % PROJECT_COLORS.length]);
  }
  return map.get(project)!;
}

function automationDotColor(automation: Automation): string {
  if (!automation.active) return "var(--text-faint)";
  if (automation.status === "failed") return "#ff8272";
  if (automation.status === "running" || automation.status === "queued") return "#90cdf4";
  if (automation.status === "skipped") return "#f6ad55";
  return "#9ae6b4";
}

function automationMetaLabel(automation: Automation): string {
  if (!automation.active) return "paused";
  return automation.status && automation.status !== "idle" ? automation.status : "active";
}

function isWindowLayout(value: unknown): value is WindowLayout {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    typeof candidate.x === "number" &&
    typeof candidate.y === "number" &&
    typeof candidate.maximized === "boolean"
  );
}

function isSelection(value: unknown): value is Selection {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === "session" && typeof candidate.name === "string") ||
    (candidate.kind === "terminal" && typeof candidate.id === "string") ||
    (candidate.kind === "automation" && typeof candidate.id === "string")
  );
}

function isDiffFile(value: unknown): value is { path: string; cwd: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.path === "string" && typeof candidate.cwd === "string";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function getWindowExpandedState(win: ReturnType<typeof getCurrentWindow>) {
  const [fullscreen, maximized] = await Promise.all([
    win.isFullscreen().catch(() => false),
    win.isMaximized().catch(() => false),
  ]);
  return { fullscreen, maximized };
}

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };
type LayoutColumn = "file" | "main" | "scratch" | "editor";
type ResizableColumn = Exclude<LayoutColumn, "main">;

const LAYOUT_DEFAULTS = {
  left: 240,
  right: 380,
  gitHeight: 220,
  sectionSplit: 200,
  automationHeight: SIDEBAR_AUTOMATIONS_DEFAULT_HEIGHT,
};
const DEFAULT_COLUMN_ORDER: LayoutColumn[] = ["file", "main", "scratch", "editor"];
const COLUMN_DRAG_THRESHOLD = 5;
const COLUMN_WIDTH_LIMITS: Record<ResizableColumn, { min: number; max: number }> = {
  file: { min: 180, max: 600 },
  scratch: { min: 220, max: 800 },
  editor: { min: 250, max: 900 },
};

let termIdCounter = 0;
let scratchIdCounter = 0;

function isLayoutColumn(value: unknown): value is LayoutColumn {
  return value === "file" || value === "main" || value === "scratch" || value === "editor";
}

function normalizeColumnOrder(value: unknown): LayoutColumn[] {
  const seen = new Set<LayoutColumn>();
  const restored = Array.isArray(value)
    ? value.filter((item): item is LayoutColumn => {
        if (!isLayoutColumn(item) || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
    : [];
  return [...restored, ...DEFAULT_COLUMN_ORDER.filter((column) => !seen.has(column))];
}

function reorderActiveColumns(
  currentOrder: LayoutColumn[],
  activeOrder: LayoutColumn[],
  from: LayoutColumn,
  to: LayoutColumn,
): LayoutColumn[] {
  const fromIndex = activeOrder.indexOf(from);
  const toIndex = activeOrder.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return currentOrder;

  const reorderedActive = [...activeOrder];
  const [moved] = reorderedActive.splice(fromIndex, 1);
  reorderedActive.splice(toIndex, 0, moved);

  const activeSet = new Set(activeOrder);
  const queue = [...reorderedActive];
  return currentOrder.map((column) => (activeSet.has(column) ? queue.shift()! : column));
}

function placeScratchAfterMain(order: LayoutColumn[]): LayoutColumn[] {
  const normalized = normalizeColumnOrder(order);
  const withoutScratch = normalized.filter((column) => column !== "scratch");
  const mainIndex = withoutScratch.indexOf("main");
  const insertAt = mainIndex < 0 ? withoutScratch.length : mainIndex + 1;
  return [
    ...withoutScratch.slice(0, insertAt),
    "scratch",
    ...withoutScratch.slice(insertAt),
  ];
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terminals, setTerminals] = useState<PlainTerminal[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRun[]>([]);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [openedSessions, setOpenedSessions] = useState<string[]>([]);
  const [openedTerminals, setOpenedTerminals] = useState<string[]>([]);
  const [cwdsBySession, setCwdsBySession] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [showNewWorktree, setShowNewWorktree] = useState(false);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });
  const [cols, setCols] = useState<{ left: number; right: number }>({
    left: LAYOUT_DEFAULTS.left,
    right: LAYOUT_DEFAULTS.right,
  });
  const [gitHeight, setGitHeight] = useState<number>(LAYOUT_DEFAULTS.gitHeight);
  const [sectionSplit, setSectionSplit] = useState<number>(LAYOUT_DEFAULTS.sectionSplit);
  const [automationHeight, setAutomationHeight] = useState<number>(
    LAYOUT_DEFAULTS.automationHeight,
  );
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null);
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const [scratchCollapsed, setScratchCollapsed] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [remoteToken, setRemoteToken] = useState("");
  const [remotePopover, setRemotePopover] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ path: string; cwd: string } | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [fileTreeWidth, setFileTreeWidth] = useState(280);
  const [editorWidth, setEditorWidth] = useState(420);
  const [columnOrder, setColumnOrder] = useState<LayoutColumn[]>(DEFAULT_COLUMN_ORDER);
  const [columnDrag, setColumnDrag] = useState<{ from: LayoutColumn; over: LayoutColumn } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [windowLayout, setWindowLayout] = useState<WindowLayout | null>(null);
  const [windowRestoreReady, setWindowRestoreReady] = useState(false);
  const appRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef<Map<LayoutColumn, HTMLElement>>(new Map());
  const activeColumnOrderRef = useRef<LayoutColumn[]>(DEFAULT_COLUMN_ORDER);
  const pendingColumnDragRef = useRef<{ column: LayoutColumn; startX: number; startY: number } | null>(null);
  const columnDragRef = useRef<{ from: LayoutColumn; over: LayoutColumn } | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const cwdRequested = useRef<Set<string>>(new Set());
  const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
  const sessionsListRef = useRef<HTMLDivElement | null>(null);
  const layoutLoadedRef = useRef(false);
  const autoResizeColumnsReadyRef = useRef(false);
  const gitHeightValueRef = useRef(gitHeight);
  const sectionSplitValueRef = useRef(sectionSplit);
  const automationHeightValueRef = useRef(automationHeight);
  const automationsRef = useRef<Automation[]>([]);
  const scheduledAutomationMinuteRef = useRef<Set<string>>(new Set());
  gitHeightValueRef.current = gitHeight;
  sectionSplitValueRef.current = sectionSplit;
  automationHeightValueRef.current = automationHeight;
  automationsRef.current = automations;

  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerWidth(e.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = sidebarSplitRef.current;
    if (!el) return;

    const normalizeForHeight = (totalHeight: number) => {
      const next = normalizeSidebarSplits({
        totalHeight,
        sectionSplit: sectionSplitValueRef.current,
        gitHeight: gitHeightValueRef.current,
        automationHeight: automationHeightValueRef.current,
      });
      if (next.sectionSplit !== sectionSplitValueRef.current) {
        sectionSplitValueRef.current = next.sectionSplit;
        setSectionSplit(next.sectionSplit);
      }
      if (next.automationHeight !== automationHeightValueRef.current) {
        automationHeightValueRef.current = next.automationHeight;
        setAutomationHeight(next.automationHeight);
      }
      if (next.gitHeight !== gitHeightValueRef.current) {
        gitHeightValueRef.current = next.gitHeight;
        setGitHeight(next.gitHeight);
      }
    };

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) normalizeForHeight(e.contentRect.height);
    });
    ro.observe(el);
    normalizeForHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = sidebarSplitRef.current;
    if (!el) return;
    const next = normalizeSidebarSplits({
      totalHeight: el.getBoundingClientRect().height,
      sectionSplit,
      gitHeight,
      automationHeight,
    });
    if (next.sectionSplit !== sectionSplit) setSectionSplit(next.sectionSplit);
    if (next.automationHeight !== automationHeight) setAutomationHeight(next.automationHeight);
    if (next.gitHeight !== gitHeight) setGitHeight(next.gitHeight);
  }, [sectionSplit, automationHeight, gitHeight]);

  useEffect(() => {
    invoke<string>("home_dir").then(setHomeDir).catch(() => {});
  }, []);

  useEffect(() => {
    if (!windowRestoreReady) return;
    const win = getCurrentWindow();
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
      unlistenResized = fn;
    });
    void win.onMoved(scheduleCapture).then((fn) => {
      unlistenMoved = fn;
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlistenResized?.();
      unlistenMoved?.();
    };
  }, [windowRestoreReady]);

  const fileTreeWidthRef = useRef(fileTreeWidth);
  fileTreeWidthRef.current = fileTreeWidth;
  const editorWidthRef = useRef(editorWidth);
  editorWidthRef.current = editorWidth;
  const prevColumnsRef = useRef({ fileBrowser: false, editor: false });

  useEffect(() => {
    const prev = prevColumnsRef.current;
    const curr = { fileBrowser: fileBrowserOpen, editor: !!(editingFile || diffFile) };
    if (!autoResizeColumnsReadyRef.current) {
      prevColumnsRef.current = curr;
      if (layoutLoadedRef.current) autoResizeColumnsReadyRef.current = true;
      return;
    }
    let delta = 0;
    if (curr.fileBrowser && !prev.fileBrowser) delta += fileTreeWidthRef.current + 1;
    if (!curr.fileBrowser && prev.fileBrowser) delta -= fileTreeWidthRef.current + 1;
    if (curr.editor && !prev.editor) delta += editorWidthRef.current + 1;
    if (!curr.editor && prev.editor) delta -= editorWidthRef.current + 1;
    prevColumnsRef.current = curr;
    if (delta !== 0) {
      (async () => {
        try {
          const win = getCurrentWindow();
          const { fullscreen, maximized } = await getWindowExpandedState(win);
          if (fullscreen || maximized) return;
          const size = await win.innerSize();
          const factor = await win.scaleFactor();
          const lw = size.width / factor + delta;
          const lh = size.height / factor;
          await win.setSize(new LogicalSize(Math.max(800, lw), lh));
        } catch {
          // Window resizing is a convenience; keep column toggles functional if it fails.
        }
      })();
    }
  }, [fileBrowserOpen, editingFile, diffFile]);

  // Load persisted data on mount
  useEffect(() => {
    invoke<PlainTerminal[]>("load_terminals")
      .then(async (saved) => {
        if (saved.length > 0) {
          const maxNum = saved.reduce((max, t) => {
            const m = t.id.match(/^term-(\d+)$/);
            return m ? Math.max(max, parseInt(m[1], 10)) : max;
          }, 0);
          termIdCounter = maxNum;
          for (const t of saved) {
            if (t.tmuxName) {
              await invoke("ensure_terminal_session", {
                name: t.tmuxName,
                cwd: t.cwd,
              }).catch(() => {});
            }
          }
          setTerminals(saved.filter((t) => t.tmuxName));
        }
      })
      .catch(() => {});
    invoke<Record<string, unknown>>("load_layout")
      .then((lay) => {
        const restoredFileBrowserOpen =
          typeof lay.fileBrowserOpen === "boolean" ? (lay.fileBrowserOpen as boolean) : false;
        const restoredEditorOpen = isDiffFile(lay.diffFile) || typeof lay.editingFile === "string";
        prevColumnsRef.current = {
          fileBrowser: restoredFileBrowserOpen,
          editor: restoredEditorOpen,
        };
        autoResizeColumnsReadyRef.current = true;
        if (typeof lay.left === "number") setCols((c) => ({ ...c, left: lay.left as number }));
        if (typeof lay.right === "number") setCols((c) => ({ ...c, right: lay.right as number }));
        if (typeof lay.gitHeight === "number") setGitHeight(lay.gitHeight as number);
        if (typeof lay.fileTreeWidth === "number") {
          setFileTreeWidth(clamp(lay.fileTreeWidth as number, 180, 600));
        }
        if (typeof lay.editorWidth === "number") {
          setEditorWidth(clamp(lay.editorWidth as number, 250, 900));
        }
        if (typeof lay.sectionSplit === "number") {
          const v = lay.sectionSplit as number;
          setSectionSplit(v < 1 ? LAYOUT_DEFAULTS.sectionSplit : v);
        }
        if (typeof lay.automationHeight === "number") {
          const v = lay.automationHeight as number;
          setAutomationHeight(v < 1 ? LAYOUT_DEFAULTS.automationHeight : v);
        }
        if (Array.isArray(lay.sessionOrder)) {
          setSessionOrder((lay.sessionOrder as string[]).filter((n) => !n.startsWith("tw-term-")));
        }
        setColumnOrder(normalizeColumnOrder(lay.columnOrder));
        if (typeof lay.scratchCollapsed === "boolean") {
          setScratchCollapsed(lay.scratchCollapsed as boolean);
        }
        setFileBrowserOpen(restoredFileBrowserOpen);
        if (isDiffFile(lay.diffFile)) {
          setDiffFile(lay.diffFile);
          setEditingFile(null);
        } else if (typeof lay.editingFile === "string") {
          setEditingFile(lay.editingFile);
          setDiffFile(null);
        }
        if (isSelection(lay.selection)) {
          setSelection(lay.selection);
        }
        if (isWindowLayout(lay.window)) setWindowLayout(lay.window);
        setWindowRestoreReady(true);
      })
      .catch(() => {
        prevColumnsRef.current = { fileBrowser: false, editor: false };
        autoResizeColumnsReadyRef.current = true;
        setWindowRestoreReady(true);
      })
      .finally(() => {
        layoutLoadedRef.current = true;
      });
  }, []);

  // Persist terminals
  useEffect(() => {
    invoke("save_terminals", { terminals }).catch(() => {});
  }, [terminals]);

  // Persist layout (debounced)
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const t = setTimeout(() => {
      invoke("save_layout", {
        layout: {
          left: cols.left,
          right: cols.right,
          gitHeight,
          sectionSplit,
          automationHeight,
          sessionOrder,
          columnOrder,
          scratchCollapsed,
          fileBrowserOpen,
          fileTreeWidth,
          editorWidth,
          selection,
          editingFile,
          diffFile,
          ...(windowLayout ? { window: windowLayout } : {}),
        },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [
    cols,
    gitHeight,
    sectionSplit,
    automationHeight,
    sessionOrder,
    columnOrder,
    scratchCollapsed,
    fileBrowserOpen,
    fileTreeWidth,
    editorWidth,
    selection,
    editingFile,
    diffFile,
    windowLayout,
  ]);

  const loadAutomations = useCallback(async () => {
    try {
      const [records, runRecords] = await Promise.all([
        invoke<AutomationRecord[]>("list_automations"),
        invoke<AutomationRunRecord[]>("list_automation_runs", { automationId: null }),
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

  const anyModalOpen = showNewWorktree || showNewTerminal;
  const editorPanelOpen = !!(editingFile || diffFile);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = cols.left;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      setCols((prev) => ({ ...prev, left: clamp(startLeft + dx, 180, 500) }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const isResizableColumn = (column: LayoutColumn): column is ResizableColumn => {
    if (column === "file") return fileBrowserOpen;
    if (column === "scratch") return !scratchCollapsed;
    return column === "editor" && editorPanelOpen;
  };

  const getColumnWidth = (column: ResizableColumn): number => {
    if (column === "file") return fileTreeWidth;
    if (column === "scratch") return cols.right;
    return editorWidth;
  };

  const setColumnWidth = (column: ResizableColumn, value: number) => {
    const next = Math.round(value);
    if (column === "file") {
      setFileTreeWidth(next);
    } else if (column === "scratch") {
      setCols((prev) => ({ ...prev, right: next }));
    } else {
      setEditorWidth(next);
    }
  };

  const canResizeColumns = (left: LayoutColumn, right: LayoutColumn) =>
    isResizableColumn(left) || isResizableColumn(right);

  const startColumnResize = (left: LayoutColumn, right: LayoutColumn) => (e: React.MouseEvent) => {
    const leftResizable = isResizableColumn(left) ? left : null;
    const rightResizable = isResizableColumn(right) ? right : null;
    if (!leftResizable && !rightResizable) return;

    e.preventDefault();
    const startX = e.clientX;
    const startLeft = leftResizable ? getColumnWidth(leftResizable) : null;
    const startRight = rightResizable ? getColumnWidth(rightResizable) : null;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (leftResizable && rightResizable && startLeft !== null && startRight !== null) {
        const leftLimits = COLUMN_WIDTH_LIMITS[leftResizable];
        const rightLimits = COLUMN_WIDTH_LIMITS[rightResizable];
        const total = startLeft + startRight;
        const minLeft = Math.max(leftLimits.min, total - rightLimits.max);
        const maxLeft = Math.min(leftLimits.max, total - rightLimits.min);

        if (minLeft <= maxLeft) {
          const nextLeft = clamp(startLeft + dx, minLeft, maxLeft);
          setColumnWidth(leftResizable, nextLeft);
          setColumnWidth(rightResizable, total - nextLeft);
          return;
        }

        setColumnWidth(leftResizable, clamp(startLeft + dx, leftLimits.min, leftLimits.max));
        setColumnWidth(rightResizable, clamp(startRight - dx, rightLimits.min, rightLimits.max));
      } else if (leftResizable && startLeft !== null) {
        const limits = COLUMN_WIDTH_LIMITS[leftResizable];
        setColumnWidth(leftResizable, clamp(startLeft + dx, limits.min, limits.max));
      } else if (rightResizable && startRight !== null) {
        const limits = COLUMN_WIDTH_LIMITS[rightResizable];
        setColumnWidth(rightResizable, clamp(startRight - dx, limits.min, limits.max));
      }
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const setColumnRef = useCallback(
    (column: LayoutColumn) => (element: HTMLElement | null) => {
      if (element) {
        columnRefs.current.set(column, element);
      } else {
        columnRefs.current.delete(column);
      }
    },
    [],
  );

  const startColumnDrag = useCallback(
    (column: LayoutColumn) => (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pendingColumnDragRef.current = { column, startX: e.clientX, startY: e.clientY };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const pending = pendingColumnDragRef.current;
      if (pending && !columnDragRef.current) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) >= COLUMN_DRAG_THRESHOLD) {
          const next = { from: pending.column, over: pending.column };
          columnDragRef.current = next;
          setColumnDrag(next);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          pendingColumnDragRef.current = null;
        }
        return;
      }

      const drag = columnDragRef.current;
      if (!drag) return;

      let best = drag.over;
      let bestDist = Infinity;
      for (const column of activeColumnOrderRef.current) {
        const element = columnRefs.current.get(column);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const dist = Math.abs(e.clientX - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = column;
        }
      }

      if (best !== drag.over) {
        const next = { ...drag, over: best };
        columnDragRef.current = next;
        setColumnDrag(next);
      }
    };

    const onUp = () => {
      pendingColumnDragRef.current = null;
      const drag = columnDragRef.current;
      if (!drag) return;

      if (drag.from !== drag.over) {
        const activeOrder = activeColumnOrderRef.current;
        setColumnOrder((currentOrder) =>
          reorderActiveColumns(currentOrder, activeOrder, drag.from, drag.over),
        );
      }

      columnDragRef.current = null;
      setColumnDrag(null);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, []);

  const startGitSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = sidebarSplitRef.current;
    if (!container) return;
    const startY = e.clientY;
    const startH = gitHeight;
    const total = container.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxGit = Math.max(
        SIDEBAR_GIT_MIN_HEIGHT,
        total -
          sectionSplitValueRef.current -
          SIDEBAR_TERMINALS_MIN_HEIGHT -
          automationHeightValueRef.current,
      );
      const h = clamp(startH - dy, SIDEBAR_GIT_MIN_HEIGHT, maxGit);
      setGitHeight(h);
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

  const startSectionSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const listContainer = sessionsListRef.current;
    if (!listContainer) return;
    const startY = e.clientY;
    const startH = sectionSplit;
    const containerH = listContainer.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxSection = Math.max(
        SIDEBAR_WORKTREES_MIN_HEIGHT,
        containerH - SIDEBAR_TERMINALS_MIN_HEIGHT - automationHeightValueRef.current,
      );
      const h = clamp(startH + dy, SIDEBAR_WORKTREES_MIN_HEIGHT, maxSection);
      setSectionSplit(h);
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

  const startAutomationSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const listContainer = sessionsListRef.current;
    if (!listContainer) return;
    const startY = e.clientY;
    const startH = automationHeight;
    const containerH = listContainer.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const maxAutomation = Math.max(
        SIDEBAR_AUTOMATIONS_MIN_HEIGHT,
        containerH - sectionSplitValueRef.current - SIDEBAR_TERMINALS_MIN_HEIGHT,
      );
      const h = clamp(startH + dy, SIDEBAR_AUTOMATIONS_MIN_HEIGHT, maxAutomation);
      setAutomationHeight(h);
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

  const sessionOrderRef = useRef(sessionOrder);
  sessionOrderRef.current = sessionOrder;

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<Session[]>("list_sessions");
      const order = sessionOrderRef.current;
      const orderMap = new Map(order.map((n, i) => [n, i]));
      list.sort((a, b) => {
        const ai = orderMap.get(a.name) ?? Infinity;
        const bi = orderMap.get(b.name) ?? Infinity;
        return ai - bi;
      });
      setSessions(list);
      setError(null);
      const live = new Set(list.map((s) => s.name));
      setOpenedSessions((prev) => prev.filter((n) => live.has(n)));
      setCwdsBySession((prev) => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (live.has(k)) next[k] = v;
        }
        return next;
      });
      setSelection((cur) => {
        if (cur?.kind === "automation") return cur;
        if (cur?.kind === "terminal") return cur;
        if (cur?.kind === "session" && live.has(cur.name)) return cur;
        if (list.length > 0) return { kind: "session", name: list[0].name };
        return null;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleAutomationCreate = useCallback(
    async (draft: AutomationDraft) => {
      const record = await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(draft),
      });
      const automation = automationFromRecord(record);
      setSelection({ kind: "automation", id: automation.id });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationSave = useCallback(
    async (id: string, draft: AutomationDraft) => {
      const record = await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(draft, id),
      });
      const automation = automationFromRecord(record);
      setSelection({ kind: "automation", id: automation.id });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationToggle = useCallback(
    async (id: string, active: boolean) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      if (!automation) return;
      await invoke<AutomationRecord>("save_automation", {
        input: automationSaveInputFromDraft(
          { ...createAutomationDraft(automation), active },
          id,
        ),
      });
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationDelete = useCallback(
    async (id: string) => {
      await invoke("delete_automation", { id });
      setAutomationRuns((prev) => prev.filter((run) => run.automationId !== id));
      setSelection((current) =>
        current?.kind === "automation" && current.id === id ? { kind: "automation", id: "" } : current,
      );
      await loadAutomations();
    },
    [loadAutomations],
  );

  const handleAutomationRun = useCallback(
    async (id: string) => {
      const automation = automationsRef.current.find((item) => item.id === id);
      const runRecord = await invoke<AutomationRunRecord>("trigger_automation", { id });
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

  // Remote tunnel helpers
  const checkRemoteStatus = useCallback(async () => {
    try {
      const status = await invoke<{ active: boolean; url: string | null; token: string; error?: string | null }>("remote_status");
      setRemoteActive(status.active);
      setRemoteUrl(status.url);
      setRemoteToken(status.token);
      setRemoteError(status.error ?? null);
      return status;
    } catch {
      return { active: false, url: null, token: "", error: null };
    }
  }, []);

  const handleRemoteToggle = useCallback(async () => {
    if (remoteActive) {
      setRemotePopover(true);
    } else {
      setRemoteLoading(true);
      setRemotePopover(true);
      setRemoteError(null);
      try {
        await invoke("remote_start");
        // Poll for URL
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          const status = await invoke<{ active: boolean; url: string | null; token: string; error?: string | null }>("remote_status");
          setRemoteError(status.error ?? null);
          if (status.active && status.url) {
            clearInterval(poll);
            setRemoteActive(true);
            setRemoteUrl(status.url);
            setRemoteToken(status.token);
            setRemoteLoading(false);
          } else if (attempts > 30) {
            clearInterval(poll);
            setRemoteError(status.error ?? "Timed out waiting for tunnel URL");
            setRemoteLoading(false);
          }
        }, 1000);
      } catch (err) {
        setRemoteError(String(err));
        setRemoteLoading(false);
      }
    }
  }, [remoteActive]);

  const handleRemoteDisconnect = useCallback(async () => {
    await invoke("remote_stop");
    setRemoteActive(false);
    setRemoteUrl(null);
    setRemoteError(null);
    setRemotePopover(false);
  }, []);

  // Check remote status on mount
  useEffect(() => { checkRemoteStatus(); }, [checkRemoteStatus]);

  // Lazy-open session terminals
  useEffect(() => {
    if (selection?.kind !== "session") return;
    const name = selection.name;
    setOpenedSessions((prev) =>
      prev.includes(name) ? prev : [...prev, name],
    );
    if (cwdsBySession[name] || cwdRequested.current.has(name)) return;
    cwdRequested.current.add(name);
    invoke<string>("session_root", { name })
      .then((cwd) => {
        if (cwd) setCwdsBySession((prev) => ({ ...prev, [name]: cwd }));
      })
      .catch(() => {})
      .finally(() => {
        cwdRequested.current.delete(name);
      });
  }, [selection, cwdsBySession]);

  // Lazy-open plain terminals
  useEffect(() => {
    if (selection?.kind !== "terminal") return;
    const id = selection.id;
    setOpenedTerminals((prev) =>
      prev.includes(id) ? prev : [...prev, id],
    );
  }, [selection]);

  // Resolve current cwd for selected item
  const selectedAutomation =
    selection?.kind === "automation"
      ? automations.find((automation) => automation.id === selection.id) ?? null
      : null;
  const selectedCwd: string | null =
    selection?.kind === "session"
      ? cwdsBySession[selection.name] ?? null
      : selection?.kind === "terminal"
        ? terminals.find((t) => t.id === selection.id)?.cwd ?? null
        : selection?.kind === "automation"
          ? selectedAutomation?.path || null
        : null;

  const fileBrowserRoot = selectedCwd ?? homeDir ?? "/";

  const handleOpenFile = useCallback((path: string, _line?: number, _col?: number) => {
    setDiffFile(null);
    setEditingFile(path);
  }, []);

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
    setColumnOrder((order) => placeScratchAfterMain(order));
    setScratchCollapsed(false);
  }, []);

  const colorMap = new Map<string, string>();
  const totalCount = sessions.length + terminals.length + automations.length;

  const sessionSortable = useSortable(
    sessions,
    (reordered) => {
      setSessions(reordered);
      setSessionOrder(reordered.map((s) => s.name));
    },
  );

  const terminalSortable = useSortable(
    terminals,
    (reordered) => setTerminals(reordered),
  );

  const SPLITTER_W = 1;
  const scratchWidth = cols.right;
  const isColumnActive = (column: LayoutColumn) => {
    if (column === "file") return fileBrowserOpen;
    if (column === "scratch") return !scratchCollapsed;
    if (column === "editor") return editorPanelOpen;
    return true;
  };
  const activeColumnOrder = columnOrder.filter(isColumnActive);
  activeColumnOrderRef.current = activeColumnOrder;

  const fixedColumnsWidth = activeColumnOrder.reduce((total, column) => {
    if (column === "file") return total + fileTreeWidth;
    if (column === "scratch") return total + scratchWidth;
    if (column === "editor") return total + editorWidth;
    return total;
  }, 0);
  const mainWidth = Math.max(
    200,
    containerWidth - cols.left - fixedColumnsWidth - activeColumnOrder.length * SPLITTER_W,
  );

  const columnTrackWidth = (column: LayoutColumn) => {
    if (column === "file") return fileTreeWidth;
    if (column === "scratch") return scratchWidth;
    if (column === "editor") return editorWidth;
    return mainWidth;
  };
  const gridCols = `${cols.left}px ${SPLITTER_W}px ${activeColumnOrder
    .map((column) => `${columnTrackWidth(column)}px`)
    .join(` ${SPLITTER_W}px `)}`;

  const columnGridColumn = (column: LayoutColumn) => {
    const index = activeColumnOrder.indexOf(column);
    return index < 0 ? undefined : 3 + index * 2;
  };

  const columnClass = (column: LayoutColumn, base: string) => {
    let cls = `${base} layout-column layout-column--draggable`;
    if (columnDrag?.from === column) cls += " layout-column--dragging";
    if (columnDrag && columnDrag.over === column && columnDrag.from !== column) {
      const fromIndex = activeColumnOrder.indexOf(columnDrag.from);
      const overIndex = activeColumnOrder.indexOf(column);
      cls += fromIndex > overIndex ? " layout-column--drop-before" : " layout-column--drop-after";
    }
    return cls;
  };

  const renderColumnHandle = (column: LayoutColumn, label: string) => (
    <button
      className="column-drag-handle"
      type="button"
      onPointerDown={startColumnDrag(column)}
      title={`reorder ${label}`}
      aria-label={`reorder ${label}`}
    >
      <span />
      <span />
    </button>
  );

  const columnSplitters = activeColumnOrder.slice(1).map((right, index) => {
    const left = activeColumnOrder[index];
    const resizable = canResizeColumns(left, right);
    return (
      <div
        key={`${left}-${right}`}
        className={`splitter${resizable ? "" : " splitter--disabled"}`}
        style={{ gridColumn: 4 + index * 2 }}
        onMouseDown={resizable ? startColumnResize(left, right) : undefined}
        aria-label={`resize ${left} and ${right}`}
      />
    );
  });

  return (
    <div className="app" ref={appRef} style={{ gridTemplateColumns: gridCols }}>
      <div className="titlebar" data-tauri-drag-region />

      {/* ── Sidebar (always visible) ── */}
      <aside className="sidebar">
        <header className="sidebar__header">
          <div className="brand">
            <span className="brand__mark" />
            <span className="brand__text">tmux-worktree</span>
            <div style={{ position: "relative", marginLeft: "auto", display: "flex", alignItems: "center", gap: "2px" }}>
              <button
                className={`brand__file-btn${remoteActive ? " brand__file-btn--active" : ""}`}
                type="button"
                onClick={handleRemoteToggle}
                title="remote access"
                aria-label="remote access"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2"/>
                  <ellipse cx="8" cy="8" rx="3" ry="6.5" stroke="currentColor" strokeWidth="1.2"/>
                  <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
              <button
                className={`brand__file-btn${fileBrowserOpen ? " brand__file-btn--active" : ""}`}
                type="button"
                onClick={() => setFileBrowserOpen((prev) => !prev)}
                title="toggle file browser"
                aria-label="toggle file browser"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1.5 13.5V2.5C1.5 2.1 1.9 1.5 2.5 1.5H6L8 3.5H13.5C14.1 3.5 14.5 4 14.5 4.5V13.5C14.5 14 14.1 14.5 13.5 14.5H2.5C1.9 14.5 1.5 14 1.5 13.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                </svg>
              </button>
              {remotePopover && (
                <div className="remote-popover">
                  {remoteLoading ? (
                    <p className="remote-popover__text">Starting tunnel...</p>
                  ) : remoteUrl ? (
                    <>
                      <p className="remote-popover__label">Remote URL</p>
                      <div className="remote-popover__row">
                        <p className="remote-popover__url">{remoteUrl}</p>
                        <button className="remote-popover__copy" onClick={() => navigator.clipboard.writeText(remoteUrl)} title="Copy URL">⎘</button>
                      </div>
                      <p className="remote-popover__label">Token</p>
                      <div className="remote-popover__row">
                        <p className="remote-popover__url">{remoteToken}</p>
                        <button className="remote-popover__copy" onClick={() => navigator.clipboard.writeText(remoteToken)} title="Copy Token">⎘</button>
                      </div>
                      <button className="remote-popover__disconnect" onClick={handleRemoteDisconnect}>Disconnect</button>
                    </>
                  ) : remoteError ? (
                    <>
                      <p className="remote-popover__label">Remote failed</p>
                      <p className="remote-popover__text">{remoteError}</p>
                    </>
                  ) : (
                    <p className="remote-popover__text">Failed to start tunnel</p>
                  )}
                  <button className="remote-popover__close" onClick={() => setRemotePopover(false)}>Close</button>
                </div>
              )}
            </div>
          </div>
          <div className="sidebar__buttons">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setShowNewWorktree(true)}
            >
              + worktree
            </button>
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => setShowNewTerminal(true)}
            >
              + terminal
            </button>
          </div>
        </header>

        <div className="sidebar__split" ref={sidebarSplitRef}>
          <div className="sidebar__lists" ref={sessionsListRef}>
            {/* ── Worktrees section ── */}
            <div
              className="sidebar__section"
              style={{ height: sectionSplit, flexShrink: 0 }}
            >
              <div className="section-label">
                <span className="section-label__text">worktrees</span>
                <span className="section-label__line" />
              </div>
              <nav className={`sidebar__sessions ${sessionSortable.dragIndex !== null ? "sidebar__sessions--dragging" : ""}`} ref={sessionSortable.listRef as React.RefObject<HTMLElement>}>
                {sessions.length === 0 && !error && (
                  <div className="empty empty--small">no sessions</div>
                )}
                {error && <div className="empty empty--error">{error}</div>}
                {sessions.map((s, i) => {
                  const key = projectKey(s.name);
                  const color = colorForProject(colorMap, key);
                  const dash = s.name.indexOf("-");
                  const head = dash > 0 ? s.name.slice(0, dash) : s.name;
                  const tail = dash > 0 ? s.name.slice(dash) : "";
                  const isSelected =
                    selection?.kind === "session" && selection.name === s.name;
                  const isDragging = sessionSortable.dragIndex === i;
                  const isDragOver = sessionSortable.dragIndex !== null && sessionSortable.overIndex === i && sessionSortable.dragIndex !== i;
                  const dragOverClass = isDragOver
                    ? sessionSortable.dragIndex! > i ? "session--drag-over-before" : "session--drag-over-after"
                    : "";
                  return (
                    <div
                      key={s.name}
                      className={`session ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${dragOverClass}`}
                      onClick={() => {
                        if (sessionSortable.draggingRef.current) return;
                        setSelection({ kind: "session", name: s.name });
                      }}
                      onPointerDown={sessionSortable.onPointerDown(i)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "session", name: s.name });
                      }}
                    >
                      <span
                        className={`session__dot ${s.attached ? "session__dot--attached" : ""}`}
                        style={{ background: color }}
                      />
                      <span className="session__name">
                        <span className="session__head" style={{ color }}>
                          {head}
                        </span>
                        <span className="session__tail">{tail}</span>
                      </span>
                      <span className="session__meta">{s.window_count}w</span>
                      <button
                        type="button"
                        className="session__kill"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await invoke("kill_session", { name: s.name });
                            setSessions((prev) => prev.filter((x) => x.name !== s.name));
                            setOpenedSessions((prev) => prev.filter((n) => n !== s.name));
                            setSessionOrder((prev) => prev.filter((n) => n !== s.name));
                            if (isSelected) {
                              const remaining = sessions.filter((x) => x.name !== s.name);
                              setSelection(
                                remaining.length > 0
                                  ? { kind: "session", name: remaining[0].name }
                                  : null,
                              );
                            }
                          } catch (err) {
                            setError(String(err));
                          }
                        }}
                        title="kill session"
                        aria-label={`kill session ${s.name}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </nav>
            </div>

            {/* ── Automations section ── */}
            <div
              className="sidebar__section sidebar__section--automations"
              style={{ flex: `0 0 ${automationHeight}px` }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startSectionSplit}
              >
                <span className="section-label__text">automations</span>
                <span className="section-label__line" />
                <button
                  className="btn btn--small"
                  type="button"
                  onClick={() => setSelection({ kind: "automation", id: "" })}
                  title="new automation"
                  aria-label="new automation"
                >
                  +
                </button>
              </div>
              <nav className="sidebar__sessions sidebar__sessions--compact">
                {automationError && <div className="empty empty--error">{automationError}</div>}
                {automations.length === 0 && !automationError && (
                  <div className="empty empty--small">no automations</div>
                )}
                {automations.map((automation) => {
                  const isSelected =
                    selection?.kind === "automation" && selection.id === automation.id;
                  return (
                    <div
                      key={automation.id}
                      className={`session ${isSelected ? "session--selected" : ""}`}
                      onClick={() => setSelection({ kind: "automation", id: automation.id })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "automation", id: automation.id });
                      }}
                    >
                      <span
                        className={`session__dot ${automation.active ? "session__dot--attached" : ""}`}
                        style={{ background: automationDotColor(automation) }}
                      />
                      <span className="session__name" title={automation.name}>
                        <span className="session__head">{automation.name || "(unnamed)"}</span>
                        <span className="session__tail"> · {triggerLabel(automation)}</span>
                      </span>
                      <span className="session__meta">{automationMetaLabel(automation)}</span>
                    </div>
                  );
                })}
              </nav>
            </div>

            {/* ── Terminals section ── */}
            <div
              className="sidebar__section"
              style={{ flex: "1 1 0", minHeight: 40 }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startAutomationSplit}
              >
                <span className="section-label__text">terminals</span>
                <span className="section-label__line" />
              </div>
              <nav className={`sidebar__sessions ${terminalSortable.dragIndex !== null ? "sidebar__sessions--dragging" : ""}`} ref={terminalSortable.listRef as React.RefObject<HTMLElement>}>
                {terminals.length === 0 && (
                  <div className="empty empty--small">no terminals</div>
                )}
                {terminals.map((t, i) => {
                  const isSelected =
                    selection?.kind === "terminal" && selection.id === t.id;
                  const isDragging = terminalSortable.dragIndex === i;
                  const isDragOver = terminalSortable.dragIndex !== null && terminalSortable.overIndex === i && terminalSortable.dragIndex !== i;
                  const dragOverClass = isDragOver
                    ? terminalSortable.dragIndex! > i ? "session--drag-over-before" : "session--drag-over-after"
                    : "";
                  return (
                    <div
                      key={t.id}
                      className={`session ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${dragOverClass}`}
                      onClick={() => {
                        if (terminalSortable.draggingRef.current) return;
                        setSelection({ kind: "terminal", id: t.id });
                      }}
                      onPointerDown={terminalSortable.onPointerDown(i)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "terminal", id: t.id });
                      }}
                    >
                      <span className="session__dot" style={{ background: "var(--text-faint)" }} />
                      <span className="session__name" onDoubleClick={() => setRenamingTerminal(t.id)}>
                        {renamingTerminal === t.id ? (
                          <input
                            className="session__rename-input"
                            defaultValue={t.label}
                            autoFocus
                            spellCheck={false}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setRenamingTerminal(null);
                              } else if (e.key === "Enter") {
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                            onBlur={(e) => {
                              const val = e.target.value.trim();
                              if (val && val !== t.label && !terminals.some((x) => x.id !== t.id && x.label === val)) {
                                setTerminals((prev) => prev.map((x) => x.id === t.id ? { ...x, label: val } : x));
                              }
                              setRenamingTerminal(null);
                            }}
                          />
                        ) : (
                          <span className="session__head">{t.label}</span>
                        )}
                      </span>
                      <span className="session__meta dim">zsh</span>
                      <button
                        type="button"
                        className="session__kill"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          invoke("kill_plain_terminal", { name: t.tmuxName }).catch(() => {});
                          setTerminals((prev) =>
                            prev.filter((x) => x.id !== t.id),
                          );
                          setOpenedTerminals((prev) =>
                            prev.filter((x) => x !== t.id),
                          );
                          if (isSelected) {
                            setSelection(
                              sessions.length > 0
                                ? { kind: "session", name: sessions[0].name }
                                : null,
                            );
                          }
                        }}
                        title="close terminal"
                        aria-label={`close terminal ${t.label}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </nav>
            </div>
          </div>

          <div className="sidebar__git" style={{ height: gitHeight }}>
            <div
              className="section-label section-label--draggable"
              onMouseDown={startGitSplit}
            >
              <span className="section-label__text">git</span>
              <span className="section-label__line" />
            </div>
            <GitStatusPanel
              cwd={selectedCwd}
              sessionName={selection?.kind === "session" ? selection.name : undefined}
              onFileClick={(filePath, cwd) => {
                if (cwd) {
                  setEditingFile(null);
                  setDiffFile({ path: filePath, cwd });
                }
              }}
            />
          </div>
        </div>

        <footer className="sidebar__footer">
          <span className="dim">
            {totalCount} item{totalCount === 1 ? "" : "s"}
          </span>
          <ThemePicker current={theme} onChange={setTheme} />
        </footer>
      </aside>

      {/* ── Left splitter (always visible) ── */}
      <div
        className="splitter"
        style={{ gridColumn: 2 }}
        onMouseDown={startSidebarResize}
        aria-label="resize sidebar"
      />
      {columnSplitters}

      {/* ── File tree column (inserted when open) ── */}
      {fileBrowserOpen && (
        <aside
          className={columnClass("file", "file-tree-panel")}
          ref={setColumnRef("file")}
          style={{ gridColumn: columnGridColumn("file") }}
        >
          {renderColumnHandle("file", "file tree")}
          <FileTree
            root={fileBrowserRoot}
            selectedFile={editingFile}
            onFileSelect={(path) => { setDiffFile(null); setEditingFile(path); }}
          />
        </aside>
      )}

      {/* ── Main terminal (always visible) ── */}
      <main
        className={columnClass("main", "main")}
        ref={setColumnRef("main")}
        style={{ gridColumn: columnGridColumn("main") }}
      >
        {renderColumnHandle("main", "main terminal")}
        {selection?.kind === "automation" ? (
          <div className="pane pane--automation">
            <div className="pane__bar">
              <span className="pane__title">
                {selectedAutomation?.name || "new automation"}
              </span>
              <div className="pane__bar-actions">
                <span className="pane__hint dim">
                  {selectedAutomation ? triggerLabel(selectedAutomation) : "draft"}
                </span>
              </div>
            </div>
            <div className="pane__body pane__body--automation">
              {automationError && <div className="modal__error">{automationError}</div>}
              <AutomationPanel
                automations={automations}
                selectedId={selection.id || null}
                runs={automationRuns}
                onSelect={(id) => setSelection({ kind: "automation", id })}
                onCreate={handleAutomationCreate}
                onToggle={handleAutomationToggle}
                onRun={handleAutomationRun}
                onDelete={handleAutomationDelete}
                onSave={handleAutomationSave}
                showList={false}
              />
            </div>
          </div>
        ) : selection ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">
                {selection.kind === "session"
                  ? selection.name
                  : terminals.find((t) => t.id === selection.id)?.label ??
                    selection.id}
              </span>
              <div className="pane__bar-actions">
                <span className="pane__hint dim">
                  {selection.kind === "session" ? "tmux attach" : "zsh"}
                </span>
                <button
                  className={`brand__file-btn scratch__toggle-btn${scratchCollapsed ? "" : " brand__file-btn--active"}`}
                  type="button"
                  onClick={() => {
                    if (scratchCollapsed) {
                      openScratch();
                    } else {
                      setScratchCollapsed(true);
                    }
                  }}
                  title={scratchCollapsed ? "展开 scratch" : "收起 scratch"}
                  aria-label={scratchCollapsed ? "展开 scratch" : "收起 scratch"}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M9.5 2.5V13.5" stroke="currentColor" strokeWidth="1.2"/>
                    <path d="M11.4 6L9.8 8L11.4 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            <div className="pane__body pane__body--stack">
              {openedSessions.map((name) => (
                <div
                  key={`s:${name}`}
                  className="term-slot"
                  style={{
                    display:
                      selection?.kind === "session" && selection.name === name
                        ? "flex"
                        : "none",
                  }}
                >
                  <Terminal
                    cmd="tmux"
                    args={["attach-session", "-t", name]}
                    cwd={cwdsBySession[name]}
                    active={
                      !anyModalOpen &&
                      selection?.kind === "session" && selection.name === name
                    }
                    tmuxSession={name}
                    onOpenFile={handleOpenFile}
                  />
                </div>
              ))}
              {openedTerminals.map((id) => {
                const t = terminals.find((x) => x.id === id);
                if (!t) return null;
                return (
                  <div
                    key={`t:${id}`}
                    className="term-slot"
                    style={{
                      display:
                        selection?.kind === "terminal" && selection.id === id
                          ? "flex"
                          : "none",
                    }}
                  >
                    <Terminal
                      cmd="tmux"
                      args={["attach-session", "-t", t.tmuxName]}
                      cwd={t.cwd}
                      active={
                        !anyModalOpen &&
                        selection?.kind === "terminal" && selection.id === id
                      }
                      tmuxSession={t.tmuxName}
                      onOpenFile={handleOpenFile}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="pane pane--empty">
            <div className="pane__hint">
              select a session, terminal, or automation
            </div>
          </div>
        )}
      </main>

      {/* ── Scratch panel ── */}
      {!scratchCollapsed && (
        <aside
          className={columnClass("scratch", "scratch")}
          ref={setColumnRef("scratch")}
          style={{ gridColumn: columnGridColumn("scratch") }}
        >
          {renderColumnHandle("scratch", "scratch")}
          {scratchTerminals.size > 0 ? (
            <div className="pane pane--term">
              <div className="pane__bar">
                <span className="pane__title">scratch</span>
                <div className="pane__bar-actions">
                  <button
                    className="btn btn--small"
                    type="button"
                    onClick={addScratchTerminal}
                  >
                    +
                  </button>
                </div>
              </div>
              {Array.from(scratchTerminals.entries()).map(([key, state]) => {
                const isActive = key === selectionKey;
                const cwdForKey = (() => {
                  if (key.startsWith("s:")) {
                    return cwdsBySession[key.slice(2)] ?? null;
                  }
                  if (key.startsWith("t:")) {
                    return terminals.find((t) => t.id === key.slice(2))?.cwd ?? null;
                  }
                  return null;
                })();
                if (!cwdForKey) return null;
                return (
                  <div
                    key={key}
                    className="scratch__sections"
                    ref={isActive ? scratchSectionsRef : undefined}
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {state.list.map((st, i) => (
                      <div key={st.id} className="scratch__section">
                        <div
                          className={`section-label${i > 0 ? " section-label--draggable" : ""}`}
                          onMouseDown={i > 0 ? startScratchSplit(i) : undefined}
                        >
                          <span className="section-label__text">{st.label}</span>
                          <div className="section-label__line" />
                          {state.list.length > 1 && (
                            <button
                              className="scratch__close"
                              type="button"
                              onClick={() => removeScratchTerminal(st.id)}
                            >
                              ×
                            </button>
                          )}
                        </div>
                        <div className="scratch__term">
                          <Terminal
                            cmd="/bin/zsh"
                            args={["-l"]}
                            cwd={cwdForKey}
                            active={isActive && !anyModalOpen}
                            onOpenFile={handleOpenFile}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pane pane--empty">
              <div className="pane__hint">scratch</div>
            </div>
          )}
        </aside>
      )}

      {/* ── Editor column (appended when a file is selected) ── */}
      {editorPanelOpen && (
        <aside
          className={columnClass("editor", "editor-panel")}
          ref={setColumnRef("editor")}
          style={{ gridColumn: columnGridColumn("editor") }}
        >
          {renderColumnHandle("editor", "editor")}
          {diffFile ? (
            <DiffViewer
              cwd={diffFile.cwd}
              filePath={diffFile.path}
              onClose={() => setDiffFile(null)}
            />
          ) : editingFile ? (
            <FileEditor filePath={editingFile} onClose={() => setEditingFile(null)} onOpenFile={handleOpenFile} />
          ) : null}
        </aside>
      )}

      {showNewWorktree && (
        <NewWorktreeModal
          onClose={() => setShowNewWorktree(false)}
          onCreated={(sessionName) => {
            setShowNewWorktree(false);
            setSelection({ kind: "session", name: sessionName });
            refresh();
          }}
        />
      )}

      {showNewTerminal && (
        <NewTerminalModal
          existingLabels={terminals.map((t) => t.label)}
          onClose={() => setShowNewTerminal(false)}
          onCreated={async (label, cwd) => {
            try {
              const tmuxName = await invoke<string>("create_plain_terminal", { cwd });
              const id = `term-${++termIdCounter}`;
              setTerminals((prev) => [...prev, { id, label, cwd, tmuxName }]);
              setShowNewTerminal(false);
              setSelection({ kind: "terminal", id });
            } catch (e) {
              setError(String(e));
              setShowNewTerminal(false);
            }
          }}
        />
      )}
    </div>
  );
}

export default App;
