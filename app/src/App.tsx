import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "./Terminal";
import { NewWorktreeModal } from "./NewWorktreeModal";
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
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

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

  const colorMap = new Map<string, string>();

  return (
    <div className="app">
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
              <button
                key={s.name}
                type="button"
                className={`session ${isSelected ? "session--selected" : ""}`}
                onClick={() => setSelected(s.name)}
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
              </button>
            );
          })}
        </nav>

        <footer className="sidebar__footer">
          <span className="dim">{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
        </footer>
      </aside>

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

      <aside className="scratch">
        <div className="pane pane--term">
          <div className="pane__bar">
            <span className="pane__title">scratch</span>
            <span className="pane__hint dim">zsh</span>
          </div>
          <div className="pane__body">
            <Terminal cmd="/bin/zsh" args={["-l"]} />
          </div>
        </div>
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
