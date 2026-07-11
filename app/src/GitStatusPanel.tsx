import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type GitGraphPreset,
  type GitGraphRefs,
  type GitGraphResponse,
  type GitStatus,
  useDashboardBackend,
} from "./platform";
import { useVisibilityAwarePolling } from "./dashboard/hooks/useVisibilityAwarePolling";
import { GitGraphView } from "./GitGraphView";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "./latestRequestGate";
export type { GitFile, GitStatus } from "./platform";

type Props = {
  cwd: string | null;
  sessionName?: string;
  hostId?: string | null;
  active?: boolean;
  onFileClick?: (filePath: string, cwd: string, hostId?: string | null) => void;
  onBranchChange?: (branch: string | null) => void;
};

type Tab = "files" | "log";

type GitPanelResult = {
  sourceKey: string;
  status: GitStatus | null;
  statusCwd: string | null;
  graphRefs: GitGraphRefs | null;
  graph: GitGraphResponse | null;
  error: string | null;
  loading: boolean;
};

const REFRESH_MS = 4000;
const GRAPH_REFRESH_MS = 30_000;
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

export function GitStatusPanel({
  cwd,
  sessionName,
  hostId,
  active = true,
  onFileClick,
  onBranchChange,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const [tab, setTab] = useState<Tab>("files");
  const [graphPreset, setGraphPreset] = useState<GitGraphPreset>("current");
  const [selectedGraphRefs, setSelectedGraphRefs] = useState<string[]>([]);
  const [graphLimit, setGraphLimit] = useState(160);
  const selectedGraphRefsKey = useMemo(
    () => [...selectedGraphRefs].sort().join("\0"),
    [selectedGraphRefs],
  );
  const graphContextKey = requestSourceKey(hostId ?? null, cwd, sessionName);
  const sourceKey = requestSourceKey(
    hostId ?? null,
    cwd,
    sessionName,
    tab,
    graphPreset,
    selectedGraphRefsKey,
    graphLimit,
  );
  const requestGateRef = useRef(createLatestRequestGate());
  const [result, setResult] = useState<GitPanelResult>(() => ({
    sourceKey,
    status: null,
    statusCwd: null,
    graphRefs: null,
    graph: null,
    error: null,
    loading: true,
  }));

  useEffect(() => {
    setGraphPreset("current");
    setSelectedGraphRefs([]);
    setGraphLimit(160);
  }, [graphContextKey]);

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
      graphRefs: current.sourceKey === sourceKey ? current.graphRefs : null,
      graph: current.sourceKey === sourceKey ? current.graph : null,
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
        graphRefs: null,
        graph: null,
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
          graphRefs: null,
          graph: null,
          error: null,
          loading: false,
        });
      } else {
        const graph = await dashboardBackend.git.graph(
          gitCwd,
          {
            preset: graphPreset,
            selectedRefs: selectedGraphRefs,
            limit: graphLimit,
          },
          hostId,
        );
        if (!requestGate.isCurrent(request)) return;
        const currentBranch = graph.current?.replace(/^refs\/heads\//, "") ?? null;
        onBranchChange?.(currentBranch);
        setResult({
          sourceKey,
          status: null,
          statusCwd: gitCwd,
          graphRefs: {
            refs: graph.refs,
            current: graph.current,
            upstream: graph.upstream,
          },
          graph,
          error: null,
          loading: false,
        });
      }
    } catch (error) {
      if (!requestGate.isCurrent(request)) return;
      const message = String(error);
      if (selectedGraphRefs.length > 0 && /(?:unknown|invalid) git ref/i.test(message)) {
        // A live tmux pane may have changed to another repository. Drop refs
        // from the previous catalog and immediately let the new source key
        // refresh, instead of trapping the panel in a permanent error state.
        setGraphPreset("current");
        setSelectedGraphRefs([]);
        setGraphLimit(160);
        return;
      }
      onBranchChange?.(null);
      setResult({
        sourceKey,
        status: null,
        statusCwd: gitCwd,
        graphRefs: null,
        graph: null,
        error: message,
        loading: false,
      });
    }
  }, [
    dashboardBackend.git,
    graphPreset,
    graphLimit,
    hostId,
    onBranchChange,
    resolveCwd,
    selectedGraphRefs,
    sourceKey,
    tab,
  ]);

  useEffect(() => {
    return () => requestGateRef.current.invalidate();
  }, [sourceKey]);

  const triggerProjectFetch = useCallback(() => {
    void dashboardBackend.git.fetchProjectRoots().catch(() => {});
  }, [dashboardBackend.git]);

  useVisibilityAwarePolling(triggerProjectFetch, {
    enabled: active,
    visibleIntervalMs: PROJECT_FETCH_MS,
    hiddenIntervalMs: HIDDEN_PROJECT_FETCH_MS,
  });
  useVisibilityAwarePolling(refresh, {
    enabled: active && (!!cwd || !!sessionName),
    visibleIntervalMs: tab === "files" ? REFRESH_MS : GRAPH_REFRESH_MS,
    hiddenIntervalMs: HIDDEN_REFRESH_MS,
    refreshKey: `${active}\0${cwd ?? ""}\0${sessionName ?? ""}\0${hostId ?? ""}\0${tab}\0${graphPreset}\0${selectedGraphRefsKey}\0${graphLimit}`,
  });

  const currentResult: GitPanelResult = result.sourceKey === sourceKey
    ? result
    : {
        sourceKey,
        status: null,
        statusCwd: null,
        graphRefs: null,
        graph: null,
        error: null,
        loading: true,
      };
  const { status, statusCwd, graphRefs, graph, error, loading } = currentResult;

  const tabs = (
    <div className="git__tabs" role="group" aria-label="Git view">
      <button
        type="button"
        className={`git__tab ${tab === "files" ? "git__tab--active" : ""}`}
        aria-pressed={tab === "files"}
        onClick={() => setTab("files")}
      >
        files
      </button>
      <button
        type="button"
        className={`git__tab ${tab === "log" ? "git__tab--active" : ""}`}
        aria-pressed={tab === "log"}
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

  if (error && tab === "files") {
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

  return (
    <div className="git">
      <div className="git__header">
        <span className="git__branch dim">
          {graph?.current?.replace(/^refs\/heads\//, "") ?? "history"}
        </span>
        {tabs}
      </div>
      <GitGraphView
        refs={graphRefs}
        response={graph}
        preset={graphPreset}
        selectedRefs={selectedGraphRefs}
        loading={loading}
        error={error}
        onPresetChange={(preset) => {
          setGraphPreset(preset);
          setGraphLimit(160);
          setSelectedGraphRefs((current) => {
            if (preset === "all") return [];
            const implicit = new Set([
              graphRefs?.current,
              ...(preset === "current" ? [graphRefs?.upstream] : []),
            ].filter((ref): ref is string => Boolean(ref)));
            return current.filter((ref) => !implicit.has(ref));
          });
        }}
        onAddRef={(ref) => {
          setGraphLimit(160);
          setSelectedGraphRefs((current) => current.includes(ref) ? current : [...current, ref]);
        }}
        onRemoveRef={(ref) => {
          setGraphLimit(160);
          setSelectedGraphRefs((current) => current.filter((candidate) => candidate !== ref));
        }}
        onRefresh={() => void refresh()}
        onLoadMore={graph?.hasMore && graphLimit < 2000
          ? () => setGraphLimit((current) => Math.min(2000, current + 160))
          : undefined}
        onSelectCommit={() => {}}
      />
    </div>
  );
}
