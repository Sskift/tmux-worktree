import {
  FileDiff,
  GitBranch,
  GitCompareArrows,
  Plus,
  RefreshCw,
  Search,
  Tag,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { layoutGitGraph, type GitGraphEdgeLayout } from "./gitGraphLayout";
import type {
  GitGraphCommit as PlatformGitGraphCommit,
  GitGraphPreset as PlatformGitGraphPreset,
  GitGraphRef as PlatformGitGraphRef,
  GitGraphRefs as PlatformGitGraphRefs,
  GitGraphResponse as PlatformGitGraphResponse,
} from "./platform";
import "./GitGraphView.css";

export type GitGraphPreset = PlatformGitGraphPreset;
export type GitGraphRef = PlatformGitGraphRef;
export type GitGraphRefsResponse = PlatformGitGraphRefs;
export type GitGraphCommit = PlatformGitGraphCommit;

export type GitGraphComparison = {
  ref: string;
  ahead: number | null;
  behind: number | null;
};

export type GitGraphCommitDetails = {
  mergeBase?: string | null;
  comparisons?: GitGraphComparison[];
  changedFiles?: number | null;
};

export type GitGraphResponse = PlatformGitGraphResponse & {
  /** Optional enrichment; the base gitGraph response can be passed unchanged. */
  details?: Record<string, GitGraphCommitDetails>;
};

export type GitGraphViewProps = {
  refs: GitGraphRefsResponse | null;
  response: GitGraphResponse | null;
  preset: GitGraphPreset;
  selectedRefs: readonly string[];
  loading: boolean;
  error: string | null;
  onPresetChange: (preset: GitGraphPreset) => void;
  onAddRef: (ref: string) => void;
  onRemoveRef: (ref: string) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onSelectCommit: (commitHash: string | null) => void;
  onOpenDiff?: (commitHash: string) => void;
  onCompareRefs?: (refs: readonly string[]) => void;
};

const ROW_HEIGHT = 54;
const LANE_STEP = 16;
const GRAPH_PADDING = 12;
const MIN_GRAPH_WIDTH = 40;
const NODE_RADIUS = 4;
const MERGE_NODE_RADIUS = 5;
const SELECTED_NODE_RADIUS = 7;
const LANE_COLORS = 6;

const PRESETS: ReadonlyArray<{ value: GitGraphPreset; label: string }> = [
  { value: "head", label: "HEAD" },
  { value: "current", label: "Current" },
  { value: "all", label: "All" },
];

function normalizedRefKind(ref: GitGraphRef): "head" | "branch" | "remote" | "tag" {
  const kind = ref.kind.toLowerCase();
  if (kind.includes("tag")) return "tag";
  if (ref.current || kind.includes("head")) return "head";
  if (kind.includes("remote")) return "remote";
  return "branch";
}

function laneClass(lane: number): string {
  return `git-graph__lane-${lane % LANE_COLORS}`;
}

function graphX(lane: number): number {
  return GRAPH_PADDING + lane * LANE_STEP;
}

function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function edgePath(edge: GitGraphEdgeLayout, rowCount: number): string {
  const fromX = graphX(edge.fromLane);
  const fromY = rowY(edge.fromRow);
  const toX = graphX(edge.toLane);
  const toY = edge.truncated ? rowCount * ROW_HEIGHT : rowY(edge.toRow);
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`;

  const bend = Math.min(ROW_HEIGHT * 0.46, Math.max(12, (toY - fromY) * 0.35));
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`;
}

function refLabel(ref: GitGraphRef) {
  const kind = normalizedRefKind(ref);
  return (
    <span
      className={`git-graph__ref-label git-graph__ref-label--${kind}`}
      title={ref.name}
    >
      {kind === "tag" ? <Tag aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
      <span>{ref.shortName || ref.name}</span>
    </span>
  );
}

function comparisonValue(value: number | null | undefined, label: string) {
  return <span>{value == null ? "—" : value} {label}</span>;
}

export function GitGraphView({
  refs,
  response,
  preset,
  selectedRefs,
  loading,
  error,
  onPresetChange,
  onAddRef,
  onRemoveRef,
  onRefresh,
  onLoadMore,
  onSelectCommit,
  onOpenDiff,
  onCompareRefs,
}: GitGraphViewProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refQuery, setRefQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  const [focusedRow, setFocusedRow] = useState(0);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const pickerRootRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const pickerOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const availableRefs = useMemo(() => {
    const selected = new Set(selectedRefs);
    const implicit = new Set<string>();
    if (refs?.current) implicit.add(refs.current);
    if (preset === "current" && refs?.upstream) implicit.add(refs.upstream);
    const query = refQuery.trim().toLocaleLowerCase();
    return (refs?.refs ?? []).filter((ref) => {
      if (selected.has(ref.name) || implicit.has(ref.name)) return false;
      if (!query) return true;
      return `${ref.shortName}\n${ref.name}`.toLocaleLowerCase().includes(query);
    });
  }, [preset, refQuery, refs, selectedRefs]);

  const selectedRefModels = useMemo<GitGraphRef[]>(() => {
    const byName = new Map((refs?.refs ?? []).map((ref) => [ref.name, ref]));
    return selectedRefs.map((name) => byName.get(name) ?? {
      name,
      shortName: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
      kind: name.includes("tags/") ? "tag" as const : name.includes("remotes/") ? "remote" as const : "local" as const,
      current: name === refs?.current,
      upstream: name === refs?.upstream ? name : null,
    });
  }, [refs, selectedRefs]);

  const commits = response?.commits ?? [];
  const layout = useMemo(() => layoutGitGraph(commits.map((commit) => ({
    id: commit.hash,
    parentIds: commit.parents,
  }))), [commits]);
  const graphWidth = Math.max(
    MIN_GRAPH_WIDTH,
    GRAPH_PADDING * 2 + Math.max(0, layout.laneCount - 1) * LANE_STEP,
  );
  const graphHeight = commits.length * ROW_HEIGHT;
  const graphStyle = { "--git-graph-width": `${graphWidth}px` } as CSSProperties;
  const selectedCommit = commits.find((commit) => commit.hash === selectedCommitHash) ?? null;
  const selectedDetails = selectedCommit ? response?.details?.[selectedCommit.hash] : undefined;
  const comparisons = selectedDetails?.comparisons ?? [];

  useEffect(() => {
    if (!pickerOpen) return;
    pickerInputRef.current?.focus();
    setPickerIndex(0);
  }, [pickerOpen]);

  useEffect(() => {
    setPickerIndex((index) => Math.min(index, Math.max(0, availableRefs.length - 1)));
  }, [availableRefs.length]);

  useEffect(() => {
    if (!pickerOpen) return;
    pickerOptionRefs.current[pickerIndex]?.scrollIntoView({ block: "nearest" });
  }, [pickerIndex, pickerOpen]);

  useEffect(() => {
    setFocusedRow((index) => commits.length === 0 ? 0 : Math.min(index, commits.length - 1));
  }, [commits.length]);

  useEffect(() => {
    if (!selectedCommitHash || commits.some((commit) => commit.hash === selectedCommitHash)) return;
    setSelectedCommitHash(null);
    onSelectCommit(null);
  }, [commits, onSelectCommit, selectedCommitHash]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!pickerRootRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pickerOpen]);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setRefQuery("");
    pickerButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (preset === "all" && pickerOpen) closePicker();
  }, [closePicker, pickerOpen, preset]);

  const addRef = useCallback((ref: GitGraphRef) => {
    onAddRef(ref.name);
    closePicker();
  }, [closePicker, onAddRef]);

  const selectCommit = useCallback((hash: string | null) => {
    setSelectedCommitHash(hash);
    onSelectCommit(hash);
  }, [onSelectCommit]);

  const handlePickerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPickerIndex((index) => availableRefs.length === 0 ? 0 : Math.min(index + 1, availableRefs.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPickerIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter" && availableRefs[pickerIndex]) {
      event.preventDefault();
      addRef(availableRefs[pickerIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
    }
  };

  const handleCommitKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    commit: GitGraphCommit,
  ) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = Math.min(commits.length - 1, index + 1);
    if (event.key === "ArrowUp") nextIndex = Math.max(0, index - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = commits.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      setFocusedRow(nextIndex);
      rowRefs.current[nextIndex]?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectCommit(commit.hash);
    } else if (event.key === "Escape") {
      event.preventDefault();
      selectCommit(null);
    }
  };

  return (
    <section className="git-graph" aria-label="Git commit graph" aria-busy={loading}>
      <div className="git-graph__controls">
        <div className="git-graph__scope-row">
          <div className="git-graph__scope" role="group" aria-label="Commit scope">
            {PRESETS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={preset === option.value ? "git-graph__scope-button git-graph__scope-button--active" : "git-graph__scope-button"}
                aria-pressed={preset === option.value}
                onClick={() => onPresetChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="git-graph__icon-button"
            aria-label="Refresh commit graph"
            title="Refresh"
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? "git-graph__refresh-icon git-graph__refresh-icon--loading" : "git-graph__refresh-icon"} aria-hidden="true" />
          </button>
        </div>

        {preset === "all" ? (
          <div className="git-graph__all-scope">
            <GitBranch aria-hidden="true" />
            Showing all local branches, remotes, and tags
          </div>
        ) : (
          <div className="git-graph__refs" aria-label="Comparison refs">
            {selectedRefModels.map((ref) => {
              const kind = normalizedRefKind(ref);
              return (
                <span key={ref.name} className={`git-graph__ref-chip git-graph__ref-chip--${kind}`}>
                  {kind === "tag" ? <Tag aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                  <span title={ref.name}>{ref.shortName || ref.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove comparison ref ${ref.shortName || ref.name}`}
                    onClick={() => onRemoveRef(ref.name)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </span>
              );
            })}

            <div className="git-graph__picker-root" ref={pickerRootRef}>
              <button
                ref={pickerButtonRef}
                type="button"
                className="git-graph__add-ref"
                aria-expanded={pickerOpen}
                aria-haspopup="listbox"
                onClick={() => setPickerOpen((open) => !open)}
              >
                <Plus aria-hidden="true" />
                Add comparison branch
              </button>

              {pickerOpen && (
                <div className="git-graph__picker">
                  <label className="git-graph__picker-search">
                    <Search aria-hidden="true" />
                    <span className="sr-only">Search branches and tags</span>
                    <input
                      ref={pickerInputRef}
                      role="combobox"
                      value={refQuery}
                      placeholder="Search branches and tags"
                      aria-controls="git-graph-ref-options"
                      aria-expanded={pickerOpen}
                      aria-autocomplete="list"
                      aria-activedescendant={availableRefs[pickerIndex] ? `git-graph-ref-${pickerIndex}` : undefined}
                      onChange={(event) => setRefQuery(event.target.value)}
                      onKeyDown={handlePickerKeyDown}
                    />
                  </label>
                  <div id="git-graph-ref-options" className="git-graph__picker-options" role="listbox">
                    {availableRefs.length === 0 ? (
                      <div className="git-graph__picker-empty">No matching refs</div>
                    ) : availableRefs.map((ref, index) => (
                      <button
                        ref={(element) => { pickerOptionRefs.current[index] = element; }}
                        id={`git-graph-ref-${index}`}
                        key={ref.name}
                        type="button"
                        role="option"
                        aria-selected={index === pickerIndex}
                        className={index === pickerIndex ? "git-graph__picker-option git-graph__picker-option--active" : "git-graph__picker-option"}
                        onMouseEnter={() => setPickerIndex(index)}
                        onClick={() => addRef(ref)}
                      >
                        {normalizedRefKind(ref) === "tag" ? <Tag aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                        <span>{ref.shortName || ref.name}</span>
                        <small>{normalizedRefKind(ref)}</small>
                      </button>
                    ))}
                  </div>
                </div>
                )}
              </div>
            </div>
        )}
      </div>

      {error ? (
        <div className="git-graph__state git-graph__state--error" role="alert">
          <strong>Could not load Git history</strong>
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>Try again</button>
        </div>
      ) : !response && loading ? (
        <div className="git-graph__skeleton" aria-label="Loading commit history">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} style={{ "--git-graph-skeleton-index": index } as CSSProperties} />
          ))}
        </div>
      ) : commits.length === 0 ? (
        <div className="git-graph__state">
          <GitBranch aria-hidden="true" />
          <strong>No commits in this scope</strong>
          <span>{preset === "all" ? "No commits exist on the available refs." : "Add a branch or choose a different scope."}</span>
        </div>
      ) : (
        <div className="git-graph__history" style={graphStyle}>
          <div className="git-graph__timeline" aria-label={`${commits.length} commits`}>
            <svg
              className="git-graph__lanes"
              width={graphWidth}
              height={graphHeight}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
              aria-hidden="true"
            >
              {layout.edges.map((edge, index) => (
                <path
                  key={`${edge.fromCommitId}:${edge.toCommitId}:${index}`}
                  className={`git-graph__edge ${laneClass(edge.colorLane)}${edge.truncated ? " git-graph__edge--truncated" : ""}`}
                  d={edgePath(edge, commits.length)}
                />
              ))}
              {layout.nodes.map((node) => {
                const x = graphX(node.lane);
                const y = rowY(node.row);
                const selected = node.commitId === selectedCommitHash;
                return (
                  <g key={node.commitId} className={`${laneClass(node.lane)}${selected ? " git-graph__node--selected" : ""}`}>
                    {selected && <circle className="git-graph__node-halo" cx={x} cy={y} r={SELECTED_NODE_RADIUS} />}
                    {node.isMerge ? (
                      <path
                        className="git-graph__node git-graph__node--merge"
                        d={`M ${x} ${y - MERGE_NODE_RADIUS} L ${x + MERGE_NODE_RADIUS} ${y} L ${x} ${y + MERGE_NODE_RADIUS} L ${x - MERGE_NODE_RADIUS} ${y} Z`}
                      />
                    ) : (
                      <circle
                        className={`git-graph__node${node.isRoot ? " git-graph__node--root" : ""}`}
                        cx={x}
                        cy={y}
                        r={NODE_RADIUS}
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            <ol className="git-graph__commit-list">
              {commits.map((commit, index) => {
                const selected = commit.hash === selectedCommitHash;
                const merge = commit.parents.length > 1;
                const refSummary = commit.decorations.map((ref) => ref.shortName || ref.name).join(", ");
                return (
                  <li key={commit.hash}>
                    <button
                      ref={(element) => { rowRefs.current[index] = element; }}
                      type="button"
                      className={selected ? "git-graph__commit git-graph__commit--selected" : "git-graph__commit"}
                      tabIndex={index === focusedRow ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={`${merge ? "Merge commit" : "Commit"} ${commit.short}: ${commit.subject}${refSummary ? `. Refs: ${refSummary}` : ""}`}
                      onFocus={() => setFocusedRow(index)}
                      onKeyDown={(event) => handleCommitKeyDown(event, index, commit)}
                      onClick={() => selectCommit(commit.hash)}
                    >
                      <span className="git-graph__commit-main">
                        <span className="git-graph__commit-summary">
                          {commit.decorations.map((ref) => (
                            <span key={`${commit.hash}:${ref.name}`}>{refLabel(ref)}</span>
                          ))}
                          <span className="git-graph__subject" title={commit.subject}>{commit.subject}</span>
                        </span>
                        <code>{commit.short}</code>
                      </span>
                      <span className="git-graph__commit-meta">
                        <span title={commit.author}>{commit.author}</span>
                        <span aria-hidden="true">·</span>
                        <time>{commit.relTime}</time>
                        {merge && <span className="git-graph__merge-word">merge</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            {response?.hasMore && (
              <div className="git-graph__has-more">
                {onLoadMore ? (
                  <button type="button" onClick={onLoadMore} disabled={loading}>
                    {loading ? "Loading…" : "Load more commits"}
                  </button>
                ) : (
                  <span>History limited to the newest commits</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {selectedCommit && (
        <aside className="git-graph__details" aria-label={`Selected commit ${selectedCommit.short}`}>
          <div className="git-graph__details-title">
            <div>
              <strong>{selectedCommit.subject}</strong>
              <span>{selectedCommit.parents.length > 1 ? `Merge commit · ${selectedCommit.parents.length} parents` : `Commit ${selectedCommit.short}`}</span>
            </div>
            <button type="button" aria-label="Close commit details" onClick={() => selectCommit(null)}>
              <X aria-hidden="true" />
            </button>
          </div>

          {selectedDetails?.mergeBase && (
            <div className="git-graph__merge-base">
              <span>Merge base</span>
              <code>{selectedDetails.mergeBase}</code>
            </div>
          )}

          {comparisons.length > 0 && (
            <div className="git-graph__comparisons" aria-label="Ahead and behind by ref">
              {comparisons.map((comparison) => (
                <div key={comparison.ref}>
                  <span title={comparison.ref}>{comparison.ref.replace(/^refs\/(heads|remotes|tags)\//, "")}</span>
                  {comparisonValue(comparison.ahead, "ahead")}
                  {comparisonValue(comparison.behind, "behind")}
                </div>
              ))}
            </div>
          )}

          {(onOpenDiff || onCompareRefs) && (
            <div className="git-graph__details-actions">
              {onOpenDiff && (
                <button type="button" onClick={() => onOpenDiff(selectedCommit.hash)}>
                  <FileDiff aria-hidden="true" />
                  Open diff
                </button>
              )}
              {onCompareRefs && (
                <button
                  type="button"
                  disabled={selectedRefs.length < 2}
                  title={selectedRefs.length < 2 ? "Add two refs to compare" : undefined}
                  onClick={() => onCompareRefs(selectedRefs)}
                >
                  <GitCompareArrows aria-hidden="true" />
                  Compare refs
                </button>
              )}
            </div>
          )}
        </aside>
      )}
    </section>
  );
}
