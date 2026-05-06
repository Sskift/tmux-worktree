import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export type GitFile = { code: string; path: string };
export type GitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  files: GitFile[];
};

type Props = {
  cwd: string | null;
};

const REFRESH_MS = 4000;

function categorize(code: string): "staged" | "unstaged" | "untracked" | "conflict" {
  if (code === "??") return "untracked";
  if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) return "conflict";
  const x = code[0];
  const y = code[1];
  if (x !== "." && x !== " ") return "staged";
  if (y !== "." && y !== " ") return "unstaged";
  return "unstaged";
}

function shortCode(code: string): string {
  if (code === "??") return "?";
  const x = code[0];
  const y = code[1];
  if (x !== "." && x !== " ") return x;
  if (y !== "." && y !== " ") return y;
  return "·";
}

export function GitStatusPanel({ cwd }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const s = await invoke<GitStatus | null>("git_status", { cwd });
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    refresh();
    if (!cwd) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, cwd]);

  if (!cwd) {
    return (
      <div className="git">
        <div className="git__header">git</div>
        <div className="git__empty">no session selected</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git">
        <div className="git__header">git</div>
        <div className="git__empty git__empty--error">{error}</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="git">
        <div className="git__header">git</div>
        <div className="git__empty">{loading ? "…" : "not a git repo"}</div>
      </div>
    );
  }

  const clean =
    status.files.length === 0 && status.ahead === 0 && status.behind === 0;

  return (
    <div className="git">
      <div className="git__header">
        <span className="git__branch" title={status.upstream ?? ""}>
          {status.branch || "(detached)"}
        </span>
        <span className="git__counters">
          {status.ahead > 0 && (
            <span className="git__counter" title="ahead">
              ↑{status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            <span className="git__counter" title="behind">
              ↓{status.behind}
            </span>
          )}
        </span>
      </div>
      <div className="git__summary">
        {clean ? (
          <span className="git__clean">clean</span>
        ) : (
          <>
            {status.staged > 0 && (
              <span className="git__chip git__chip--staged">
                {status.staged} staged
              </span>
            )}
            {status.unstaged > 0 && (
              <span className="git__chip git__chip--unstaged">
                {status.unstaged} mod
              </span>
            )}
            {status.untracked > 0 && (
              <span className="git__chip git__chip--untracked">
                {status.untracked} new
              </span>
            )}
            {status.conflicts > 0 && (
              <span className="git__chip git__chip--conflict">
                {status.conflicts} ✕
              </span>
            )}
          </>
        )}
      </div>
      <div className="git__files">
        {status.files.map((f) => {
          const kind = categorize(f.code);
          return (
            <div key={f.code + f.path} className={`git__file git__file--${kind}`}>
              <span className="git__code">{shortCode(f.code)}</span>
              <span className="git__path" title={f.path}>
                {f.path}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
