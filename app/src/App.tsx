import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { NewTerminalModal } from "./NewTerminalModal";
import { ThemePicker } from "./ThemePicker";
import { GitStatusPanel } from "./GitStatusPanel";
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

const LAYOUT_DEFAULTS = { left: 240, right: 380, gitHeight: 220, sectionSplit: 0.5 };

let termIdCounter = 0;

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
  const cwdRequested = useRef<Set<string>>(new Set());
  const sidebarSplitRef = useRef<HTMLDivElement | null>(null);
  const sessionsListRef = useRef<HTMLDivElement | null>(null);

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
        if (typeof lay.sectionSplit === "number") setSectionSplit(lay.sectionSplit as number);
        if (Array.isArray(lay.sessionOrder)) {
          setSessionOrder((lay.sessionOrder as string[]).filter((n) => !n.startsWith("tw-term-")));
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
    const startW = cols[col];
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const w =
        col === "left"
          ? Math.max(180, Math.min(500, startW + dx))
          : Math.max(220, Math.min(800, startW - dx));
      setCols((prev) => ({ ...prev, [col]: w }));
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
      const h = Math.max(80, Math.min(total - 120, startH - dy));
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
    const containerRect = listContainer.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const relY = ev.clientY - containerRect.top;
      const ratio = Math.max(0.15, Math.min(0.85, relY / containerRect.height));
      setSectionSplit(ratio);
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

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${cols.left}px 5px 1fr 5px ${cols.right}px`,
      }}
    >
      <div className="titlebar" data-tauri-drag-region />
      <aside className="sidebar">
        <header className="sidebar__header">
          <div className="brand">
            <span className="brand__mark" />
            <span className="brand__text">tmux-worktree</span>
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
              style={{ flex: `${sectionSplit} 1 0` }}
            >
              <div className="section-label">
                <span className="section-label__text">worktrees</span>
                <span className="section-label__line" />
              </div>
              <nav className="sidebar__sessions" ref={sessionSortable.listRef as React.RefObject<HTMLElement>}>
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
                  return (
                    <div
                      key={s.name}
                      className={`session ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${isDragOver ? "session--drag-over" : ""}`}
                      onClick={() =>
                        setSelection({ kind: "session", name: s.name })
                      }
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
              style={{ flex: `${1 - sectionSplit} 1 0` }}
            >
              <div
                className="section-label section-label--draggable"
                onMouseDown={startSectionSplit}
              >
                <span className="section-label__text">terminals</span>
                <span className="section-label__line" />
              </div>
              <nav className="sidebar__sessions" ref={terminalSortable.listRef as React.RefObject<HTMLElement>}>
                {terminals.length === 0 && (
                  <div className="empty empty--small">no terminals</div>
                )}
                {terminals.map((t, i) => {
                  const isSelected =
                    selection?.kind === "terminal" && selection.id === t.id;
                  const isDragging = terminalSortable.dragIndex === i;
                  const isDragOver = terminalSortable.dragIndex !== null && terminalSortable.overIndex === i && terminalSortable.dragIndex !== i;
                  return (
                    <div
                      key={t.id}
                      className={`session ${isSelected ? "session--selected" : ""} ${isDragging ? "session--dragging" : ""} ${isDragOver ? "session--drag-over" : ""}`}
                      onClick={() =>
                        setSelection({ kind: "terminal", id: t.id })
                      }
                      onPointerDown={terminalSortable.onPointerDown(i)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setSelection({ kind: "terminal", id: t.id });
                      }}
                    >
                      <span className="session__dot" style={{ background: "var(--text-faint)" }} />
                      <span className="session__name">
                        <span className="session__head">{t.label}</span>
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

          <div
            className="splitter splitter--horizontal"
            onMouseDown={startGitSplit}
            aria-label="resize git panel"
          />

          <div className="sidebar__git" style={{ height: gitHeight }}>
            <GitStatusPanel cwd={selectedCwd} />
          </div>
        </div>

        <footer className="sidebar__footer">
          <span className="dim">
            {totalCount} item{totalCount === 1 ? "" : "s"}
          </span>
          <ThemePicker current={theme} onChange={setTheme} />
        </footer>
      </aside>

      <div
        className="splitter"
        onMouseDown={startResize("left")}
        aria-label="resize sidebar"
      />

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
              {/* tmux session terminals */}
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
                    active={
                      !anyModalOpen &&
                      selection?.kind === "session" && selection.name === name
                    }
                    tmuxSession={name}
                  />
                </div>
              ))}
              {/* plain terminals */}
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
                      active={
                        !anyModalOpen &&
                        selection?.kind === "terminal" && selection.id === id
                      }
                      tmuxSession={t.tmuxName}
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

      <div
        className="splitter"
        onMouseDown={startResize("right")}
        aria-label="resize scratch"
      />

      <aside className="scratch">
        {selection && selectedCwd ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">scratch</span>
              <span className="pane__hint dim">zsh</span>
            </div>
            <div className="pane__body pane__body--stack">
              {/* scratch for sessions */}
              {openedSessions.map((name) => {
                const cwd = cwdsBySession[name];
                if (!cwd) return null;
                return (
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
                      cmd="/bin/zsh"
                      args={["-l"]}
                      cwd={cwd}
                      active={
                        !anyModalOpen &&
                        selection?.kind === "session" && selection.name === name
                      }
                    />
                  </div>
                );
              })}
              {/* scratch for plain terminals */}
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
                      cmd="/bin/zsh"
                      args={["-l"]}
                      cwd={t.cwd}
                      active={
                        !anyModalOpen &&
                        selection?.kind === "terminal" && selection.id === id
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="pane pane--empty">
            <div className="pane__hint">scratch</div>
          </div>
        )}
      </aside>

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
