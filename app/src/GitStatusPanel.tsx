import { useCallback, useEffect, useRef, useState } from "react";
import { type GitCommit, type GitStatus, useDashboardBackend } from "./platform";
import { useVisibilityAwarePolling } from "./dashboard/hooks/useVisibilityAwarePolling";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "./latestRequestGate";
export type { GitCommit, GitFile, GitStatus } from "./platform";

type Props = {
  cwd: string | null;
  sessionName?: string;
  hostId?: string | null;
  onFileClick?: (filePath: string, cwd: string, hostId?: string | null) => void;
  onBranchChange?: (branch: string | null) => void;
};

type Tab = "files" | "log";

type GitPanelResult = {
  sourceKey: string;
  status: GitStatus | null;
  statusCwd: string | null;
  log: GitCommit[] | null;
  error: string | null;
  loading: boolean;
};

const REFRESH_MS = 4000;
const PROJECT_FETCH_MS = 5 * 60_000;
const HIDDEN_REFRESH_MS = 30_000;
const HIDDEN_PROJECT_FETCH_MS = 15 * 60_000;

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

export function GitStatusPanel({
  cwd,
  sessionName,
  hostId,
  onFileClick,
  onBranchChange,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const [tab, setTab] = useState<Tab>("files");
  const sourceKey = requestSourceKey(hostId ?? null, cwd, sessionName, tab);
  const requestGateRef = useRef(createLatestRequestGate());
  const [result, setResult] = useState<GitPanelResult>(() => ({
    sourceKey,
    status: null,
    statusCwd: null,
    log: null,
    error: null,
    loading: true,
  }));

  const resolveCwd = useCallback(async () => {
    if (!sessionName) return cwd;
    try {
      const liveCwd = await dashboardBackend.sessions.cwd(sessionName);
      return liveCwd || cwd;
    } catch {
      return cwd;
    }
  }, [cwd, dashboardBackend.sessions, sessionName]);

  const refresh = useCallback(async () => {
    const requestGate = requestGateRef.current;
    const request = requestGate.issue(sourceKey);
    setResult((current) => ({
      sourceKey,
      status: current.sourceKey === sourceKey ? current.status : null,
      statusCwd: current.sourceKey === sourceKey ? current.statusCwd : null,
      log: current.sourceKey === sourceKey ? current.log : null,
      error: null,
      loading: true,
    }));

    const gitCwd = await resolveCwd();
    if (!requestGate.isCurrent(request)) return;
    if (!gitCwd) {
      onBranchChange?.(null);
      setResult({
        sourceKey,
        status: null,
        statusCwd: null,
        log: null,
        error: null,
        loading: false,
      });
      return;
    }

    try {
      if (tab === "files") {
        const status = await dashboardBackend.git.status(gitCwd, hostId);
        if (!requestGate.isCurrent(request)) return;
        onBranchChange?.(status?.branch ?? null);
        setResult({
          sourceKey,
          status,
          statusCwd: gitCwd,
          log: null,
          error: null,
          loading: false,
        });
      } else {
        const log = await dashboardBackend.git.log(gitCwd, 100, hostId);
        if (!requestGate.isCurrent(request)) return;
        setResult({
          sourceKey,
          status: null,
          statusCwd: gitCwd,
          log,
          error: null,
          loading: false,
        });
      }
    } catch (error) {
      if (!requestGate.isCurrent(request)) return;
      onBranchChange?.(null);
      setResult({
        sourceKey,
        status: null,
        statusCwd: gitCwd,
        log: null,
        error: String(error),
        loading: false,
      });
    }
  }, [dashboardBackend.git, hostId, onBranchChange, resolveCwd, sourceKey, tab]);

  useEffect(() => {
    return () => requestGateRef.current.invalidate();
  }, [sourceKey]);

  const triggerProjectFetch = useCallback(() => {
    void dashboardBackend.git.fetchProjectRoots().catch(() => {});
  }, [dashboardBackend.git]);

  useVisibilityAwarePolling(triggerProjectFetch, {
    visibleIntervalMs: PROJECT_FETCH_MS,
    hiddenIntervalMs: HIDDEN_PROJECT_FETCH_MS,
  });
  useVisibilityAwarePolling(refresh, {
    enabled: !!cwd || !!sessionName,
    visibleIntervalMs: REFRESH_MS,
    hiddenIntervalMs: HIDDEN_REFRESH_MS,
    refreshKey: `${cwd ?? ""}\0${sessionName ?? ""}\0${hostId ?? ""}\0${tab}`,
  });

  const currentResult: GitPanelResult = result.sourceKey === sourceKey
    ? result
    : {
        sourceKey,
        status: null,
        statusCwd: null,
        log: null,
        error: null,
        loading: true,
      };
  const { status, statusCwd, log, error, loading } = currentResult;

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
                  {status.conflicts} conflicts
                </span>
              )}
            </>
          )}
        </div>
        <div className="git__files">
          {status.files.map((f) => {
            const kind = categorize(f.code);
            return (
              <button
                type="button"
                key={f.code + f.path}
                className={`git__file git__file--${kind}${onFileClick ? " git__file--clickable" : ""}`}
                aria-label={`Open diff for ${f.path}`}
                disabled={!onFileClick || !statusCwd}
                onClick={() => {
                  if (statusCwd) onFileClick?.(f.path, statusCwd, hostId ?? null);
                }}
              >
                <span className="git__code">{shortCode(f.code)}</span>
                <span className="git__path" title={f.path}>
                  {f.path}
                </span>
              </button>
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
