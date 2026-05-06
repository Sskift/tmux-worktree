import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
import { ThemePicker } from "./ThemePicker";
import { applyTheme, loadTheme, type ThemeId } from "./themes";
import "./App.css";

type Session = {
  name: string;
  attached: boolean;
  window_count: number;
  created: number;
  activity: number;
};

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

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scratchCwd, setScratchCwd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });
  const [cols, setCols] = useState<{ left: number; right: number }>(() => {
    try {
      const s = localStorage.getItem("tw-dashboard:cols");
      if (s) return JSON.parse(s);
    } catch {}
    return { left: 240, right: 380 };
  });

  useEffect(() => {
    localStorage.setItem("tw-dashboard:cols", JSON.stringify(cols));
  }, [cols]);

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

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<Session[]>("list_sessions");
      setSessions(list);
      setError(null);
      setSelected((cur) => {
        if (cur && list.some((s) => s.name === cur)) return cur;
        return list[0]?.name ?? null;
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

  useEffect(() => {
    if (!selected) {
      setScratchCwd(null);
      return;
    }
    let cancelled = false;
    invoke<string>("session_cwd", { name: selected })
      .then((cwd) => {
        if (!cancelled) setScratchCwd(cwd || null);
      })
      .catch(() => {
        if (!cancelled) setScratchCwd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const colorMap = new Map<string, string>();

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
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => setShowNew(true)}
          >
            + new worktree
          </button>
        </header>

        <nav className="sidebar__sessions">
          {sessions.length === 0 && !error && (
            <div className="empty">no tmux sessions</div>
          )}
          {error && <div className="empty empty--error">{error}</div>}
          {sessions.map((s) => {
            const key = projectKey(s.name);
            const color = colorForProject(colorMap, key);
            const dash = s.name.indexOf("-");
            const head = dash > 0 ? s.name.slice(0, dash) : s.name;
            const tail = dash > 0 ? s.name.slice(dash) : "";
            const isSelected = s.name === selected;
            return (
              <div
                key={s.name}
                className={`session ${isSelected ? "session--selected" : ""}`}
                onClick={() => setSelected(s.name)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelected(s.name);
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
                <span className="session__meta">
                  {s.window_count}w
                </span>
                <button
                  type="button"
                  className="session__kill"
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await invoke("kill_session", { name: s.name });
                      refresh();
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

        <footer className="sidebar__footer">
          <span className="dim">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
          <ThemePicker current={theme} onChange={setTheme} />
        </footer>
      </aside>

      <div
        className="splitter"
        onMouseDown={startResize("left")}
        aria-label="resize sidebar"
      />

      <main className="main">
        {selected ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">{selected}</span>
              <span className="pane__hint dim">tmux attach</span>
            </div>
            <div className="pane__body">
              <Terminal
                key={selected}
                cmd="tmux"
                args={["attach-session", "-t", selected]}
              />
            </div>
          </div>
        ) : (
          <div className="pane pane--empty">
            <div className="pane__hint">选一个 session 或新建一个 worktree</div>
          </div>
        )}
      </main>

      <div
        className="splitter"
        onMouseDown={startResize("right")}
        aria-label="resize scratch"
      />

      <aside className="scratch">
        {selected && scratchCwd ? (
          <div className="pane pane--term">
            <div className="pane__bar">
              <span className="pane__title">scratch</span>
              <span className="pane__hint dim">zsh</span>
            </div>
            <div className="pane__body">
              <Terminal
                key={selected}
                cmd="/bin/zsh"
                args={["-l"]}
                cwd={scratchCwd}
              />
            </div>
          </div>
        ) : (
          <div className="pane pane--empty">
            <div className="pane__hint">scratch</div>
          </div>
        )}
      </aside>

      {showNew && (
        <NewWorktreeModal
          onClose={() => setShowNew(false)}
          onCreated={(sessionName) => {
            setShowNew(false);
            setSelected(sessionName);
            refresh();
          }}
        />
      )}
    </div>
  );
}

export default App;
