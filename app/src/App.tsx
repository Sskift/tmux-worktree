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
import { useSortable } from "./useSortable";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
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
  | null;

const REFRESH_MS = 2000;

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

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };

const LAYOUT_DEFAULTS = { left: 240, right: 380, gitHeight: 220, sectionSplit: 200 };

let termIdCounter = 0;
let scratchIdCounter = 0;

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [terminals, setTerminals] = useState<PlainTerminal[]>([]);
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
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null);
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<{ path: string; cwd: string } | null>(null);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [fileTreeWidth, setFileTreeWidth] = useState(280);
  const [editorWidth, setEditorWidth] = useState(420);
  const [containerWidth, setContainerWidth] = useState(0);
  const appRef = useRef<HTMLDivElement | null>(null);
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);
  const cwdRequested = useRef<Set<string>>(new Set());
  const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
  const sessionsListRef = useRef<HTMLDivElement | null>(null);

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
    invoke<string>("home_dir").then(setHomeDir).catch(() => {});
  }, []);

  const fileTreeWidthRef = useRef(fileTreeWidth);
  fileTreeWidthRef.current = fileTreeWidth;
  const editorWidthRef = useRef(editorWidth);
  editorWidthRef.current = editorWidth;
  const prevColumnsRef = useRef({ fileBrowser: false, editor: false });

  useEffect(() => {
    const prev = prevColumnsRef.current;
    const curr = { fileBrowser: fileBrowserOpen, editor: !!(editingFile || diffFile) };
    let delta = 0;
    if (curr.fileBrowser && !prev.fileBrowser) delta += fileTreeWidthRef.current + 1;
    if (!curr.fileBrowser && prev.fileBrowser) delta -= fileTreeWidthRef.current + 1;
    if (curr.editor && !prev.editor) delta += editorWidthRef.current + 1;
    if (!curr.editor && prev.editor) delta -= editorWidthRef.current + 1;
    prevColumnsRef.current = curr;
    if (delta !== 0) {
      (async () => {
        const win = getCurrentWindow();
        const size = await win.innerSize();
        const factor = await win.scaleFactor();
        const lw = size.width / factor + delta;
        const lh = size.height / factor;
        await win.setSize(new LogicalSize(Math.max(800, lw), lh));
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
        if (typeof lay.left === "number") setCols((c) => ({ ...c, left: lay.left as number }));
        if (typeof lay.right === "number") setCols((c) => ({ ...c, right: lay.right as number }));
        if (typeof lay.gitHeight === "number") setGitHeight(lay.gitHeight as number);
        if (typeof lay.sectionSplit === "number") {
          const v = lay.sectionSplit as number;
          setSectionSplit(v < 1 ? LAYOUT_DEFAULTS.sectionSplit : v);
        }
        if (Array.isArray(lay.sessionOrder)) {
          setSessionOrder((lay.sessionOrder as string[]).filter((n) => !n.startsWith("tw-term-")));
        }
      })
      .catch(() => {});
  }, []);

  // Auto-restore orphaned worktrees on mount
  useEffect(() => {
    invoke<{ project: string; path: string; name: string }[]>("list_orphaned_worktrees")
      .then(async (orphans) => {
        for (const o of orphans) {
          await invoke("restore_worktree", { args: { path: o.path, name: o.name, aiCmd: "" } }).catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  // Persist terminals
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  useEffect(() => {
    invoke("save_terminals", { terminals }).catch(() => {});
  }, [terminals]);

  // Persist layout (debounced)
  useEffect(() => {
    const t = setTimeout(() => {
      invoke("save_layout", {
        layout: { left: cols.left, right: cols.right, gitHeight, sectionSplit, sessionOrder },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [cols, gitHeight, sectionSplit, sessionOrder]);

  const anyModalOpen = showNewWorktree || showNewTerminal;

  const startResize = (col: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = cols[col];
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (col === "left") {
        setCols((prev) => ({ ...prev, left: Math.max(180, Math.min(500, startLeft + dx)) }));
      } else {
        setCols((prev) => ({ ...prev, right: Math.max(220, Math.min(800, startLeft - dx)) }));
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

  const startResizeFileTree = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = fileTreeWidth;
    const onMove = (ev: MouseEvent) => {
      setFileTreeWidth(Math.max(180, Math.min(600, startW + (ev.clientX - startX))));
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

  const startResizeEditor = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startRight = cols.right;
    const startEditor = editorWidth;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      setCols((prev) => ({ ...prev, right: Math.max(220, startRight + dx) }));
      setEditorWidth(Math.max(250, startEditor - dx));
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

  const startGitSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = sidebarSplitRef.current;
    if (!container) return;
    const startY = e.clientY;
    const startH = gitHeight;
    const total = container.getBoundingClientRect().height;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const h = Math.max(80, Math.min(total - sectionSplit - 40, startH - dy));
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
      const h = Math.max(40, Math.min(containerH - 40, startH + dy));
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

  // Lazy-open session terminals
  useEffect(() => {
    if (selection?.kind !== "session") return;
    const name = selection.name;
    setOpenedSessions((prev) =>
      prev.includes(name) ? prev : [...prev, name],
    );
    if (cwdsBySession[name] || cwdRequested.current.has(name)) return;
    cwdRequested.current.add(name);
    invoke<string>("session_cwd", { name })
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
  const selectedCwd: string | null =
    selection?.kind === "session"
      ? cwdsBySession[selection.name] ?? null
      : selection?.kind === "terminal"
        ? terminals.find((t) => t.id === selection.id)?.cwd ?? null
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

  const colorMap = new Map<string, string>();
  const totalCount = sessions.length + terminals.length;

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

  const editorPanelOpen = !!(editingFile || diffFile);
  const SPLITTER_W = 1;
  const numSplitters = 2 + (fileBrowserOpen ? 1 : 0) + (editorPanelOpen ? 1 : 0);
  const mainWidth = Math.max(200, containerWidth - cols.left - cols.right
    - (fileBrowserOpen ? fileTreeWidth : 0)
    - (editorPanelOpen ? editorWidth : 0)
    - numSplitters * SPLITTER_W);

  const gridCols = (() => {
    let g = `${cols.left}px ${SPLITTER_W}px`;
    if (fileBrowserOpen) g += ` ${fileTreeWidth}px ${SPLITTER_W}px`;
    g += ` ${mainWidth}px ${SPLITTER_W}px ${cols.right}px`;
    if (editorPanelOpen) g += ` ${SPLITTER_W}px ${editorWidth}px`;
    return g;
  })();

  return (
    <div className="app" ref={appRef} style={{ gridTemplateColumns: gridCols }}>
      <div className="titlebar" data-tauri-drag-region />

      {/* ── Sidebar (always visible) ── */}
      <aside className="sidebar">
        <header className="sidebar__header">
          <div className="brand">
            <span className="brand__mark" />
            <span className="brand__text">tmux-worktree</span>
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

            {/* ── Terminals section ── */}
            <div
              className="sidebar__section"
              style={{ flex: "1 1 0", minHeight: 40 }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startSectionSplit}
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
              onFileClick={(filePath) => {
                if (selectedCwd) {
                  setEditingFile(null);
                  setDiffFile({ path: filePath, cwd: selectedCwd });
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
        onMouseDown={startResize("left")}
        aria-label="resize sidebar"
      />

      {/* ── File tree column (inserted when open) ── */}
      {fileBrowserOpen && (
        <>
          <aside className="file-tree-panel">
            <FileTree
              root={fileBrowserRoot}
              selectedFile={editingFile}
              onFileSelect={(path) => { setDiffFile(null); setEditingFile(path); }}
            />
          </aside>
          <div
            className="splitter"
            onMouseDown={startResizeFileTree}
            aria-label="resize file tree"
          />
        </>
      )}

      {/* ── Main terminal (always visible) ── */}
      <main className="main">
        {selection ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">
                {selection.kind === "session"
                  ? selection.name
                  : terminals.find((t) => t.id === selection.id)?.label ??
                    selection.id}
              </span>
              <span className="pane__hint dim">
                {selection.kind === "session" ? "tmux attach" : "zsh"}
              </span>
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
              select a session or create a new worktree / terminal
            </div>
          </div>
        )}
      </main>

      {/* ── Right splitter (always visible) ── */}
      <div
        className="splitter"
        onMouseDown={startResize("right")}
        aria-label="resize scratch"
      />

      {/* ── Scratch panel (always visible) ── */}
      <aside className="scratch">
        {scratchTerminals.size > 0 ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">scratch</span>
              <button
                className="btn btn--small"
                type="button"
                onClick={addScratchTerminal}
              >
                +
              </button>
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

      {/* ── Editor column (appended when a file is selected) ── */}
      {editorPanelOpen && (
        <>
          <div
            className="splitter"
            onMouseDown={startResizeEditor}
            aria-label="resize editor"
          />
          <aside className="editor-panel">
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
        </>
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
