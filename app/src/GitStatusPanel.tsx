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

export type GitCommit = {
  hash: string;
  short: string;
  parents: string[];
  subject: string;
  author: string;
  rel_time: string;
  refs: string[];
};

type Props = {
  cwd: string | null;
  sessionName?: string;
  onFileClick?: (filePath: string, cwd: string) => void;
};

type Tab = "files" | "log";

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

type RefKind = "head" | "branch" | "remote" | "tag" | "other";

function classifyRef(raw: string): { kind: RefKind; label: string } {
  const r = raw.trim();
  if (r.startsWith("HEAD ->")) {
    return { kind: "head", label: r.slice("HEAD ->".length).trim() };
  }
  if (r === "HEAD") return { kind: "head", label: "HEAD" };
  if (r.startsWith("tag:")) return { kind: "tag", label: r.slice(4).trim() };
  if (r.includes("/")) return { kind: "remote", label: r };
  return { kind: "branch", label: r };
}

export function GitStatusPanel({ cwd, sessionName, onFileClick }: Props) {
  const [tab, setTab] = useState<Tab>("files");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusCwd, setStatusCwd] = useState<string | null>(null);
  const [log, setLog] = useState<GitCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const resolveCwd = useCallback(async () => {
    if (!sessionName) return cwd;
    try {
      const liveCwd = await invoke<string>("session_cwd", { name: sessionName });
      return liveCwd || cwd;
    } catch {
      return cwd;
    }
  }, [cwd, sessionName]);

  const refresh = useCallback(async () => {
    const gitCwd = await resolveCwd();
    setStatusCwd(gitCwd);
    if (!gitCwd) {
      setStatus(null);
      setLog(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      if (tab === "files") {
        const s = await invoke<GitStatus | null>("git_status", { cwd: gitCwd });
        setStatus(s);
      } else {
        const cs = await invoke<GitCommit[]>("git_log", { cwd: gitCwd, limit: 100 });
        setLog(cs);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [resolveCwd, tab]);

  useEffect(() => {
    refresh();
    if (!cwd && !sessionName) return;
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh, cwd, sessionName]);

  const tabs = (
    <div className="git__tabs">
      <button
        type="button"
        className={`git__tab ${tab === "files" ? "git__tab--active" : ""}`}
        onClick={() => setTab("files")}
      >
        files
      </button>
      <button
        type="button"
        className={`git__tab ${tab === "log" ? "git__tab--active" : ""}`}
        onClick={() => setTab("log")}
      >
        log
      </button>
    </div>
  );

  if (!cwd && !sessionName) {
    return (
      <div className="git">
        <div className="git__header">
          <span className="git__branch dim">git</span>
          {tabs}
        </div>
        <div className="git__empty">no session selected</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git">
        <div className="git__header">
          <span className="git__branch dim">git</span>
          {tabs}
        </div>
        <div className="git__empty git__empty--error">{error}</div>
      </div>
    );
  }

  if (tab === "files") {
    if (!status) {
      return (
        <div className="git">
          <div className="git__header">
            <span className="git__branch dim">git</span>
            {tabs}
          </div>
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
          {tabs}
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
              <div
                key={f.code + f.path}
                className={`git__file git__file--${kind}${onFileClick ? " git__file--clickable" : ""}`}
                onClick={() => {
                  if (statusCwd) onFileClick?.(f.path, statusCwd);
                }}
              >
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

  if (!log) {
    return (
      <div className="git">
        <div className="git__header">
          <span className="git__branch dim">log</span>
          {tabs}
        </div>
        <div className="git__empty">{loading ? "…" : "no commits"}</div>
      </div>
    );
  }

  return (
    <div className="git">
      <div className="git__header">
        <span className="git__branch dim">log · {log.length}</span>
        {tabs}
      </div>
      <div className="git__commits">
        {log.length === 0 ? (
          <div className="git__empty">no commits</div>
        ) : (
          log.map((c) => {
            const merge = c.parents.length > 1;
            return (
              <div key={c.hash} className="git__commit" title={c.hash}>
                <div className="git__commit-row">
                  <span
                    className={`git__hash ${merge ? "git__hash--merge" : ""}`}
                    title={merge ? `merge (${c.parents.length} parents)` : c.hash}
                  >
                    {merge ? "⑃ " : ""}
                    {c.short}
                  </span>
                  {c.refs.map((r, i) => {
                    const { kind, label } = classifyRef(r);
                    return (
                      <span
                        key={i}
                        className={`git__ref git__ref--${kind}`}
                        title={r}
                      >
                        {label}
                      </span>
                    );
                  })}
                  <span className="git__subject" title={c.subject}>
                    {c.subject}
                  </span>
                </div>
                <div className="git__commit-meta">
                  <span className="git__author">{c.author}</span>
                  <span className="dim">·</span>
                  <span className="git__time">{c.rel_time}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
