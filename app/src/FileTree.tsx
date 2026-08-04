import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, Search } from "lucide-react";
import {
  type DirEntry,
  type FileSearchResult,
  useDashboardBackend,
} from "./platform";
import {
  createFileTreeRequestGate,
  fileTreeErrorMessage,
  fileTreeSourceKey,
  readFileTreeDirectory,
} from "./fileTreeData";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "./latestRequestGate";
export type { DirEntry } from "./platform";

type Props = {
  root: string;
  hostId?: string | null;
  selectedFile: string | null;
  onFileSelect: (path: string, hostId: string | null) => void;
  showHidden?: boolean;
};

const INDENT_PX = 20;

type FileTreeSearchState = {
  sourceKey: string;
  results: FileSearchResult[];
  searching: boolean;
};

export function FileTree({
  root,
  hostId = null,
  selectedFile,
  onFileSelect,
  showHidden = true,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const sourceKey = fileTreeSourceKey(root, hostId);
  const isRemote = hostId != null;
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const requestGateRef = useRef<ReturnType<typeof createFileTreeRequestGate> | null>(null);
  const searchRequestGateRef = useRef(createLatestRequestGate());

  if (!requestGateRef.current) {
    requestGateRef.current = createFileTreeRequestGate(sourceKey);
  }

  useLayoutEffect(() => {
    requestGateRef.current?.switchSource(sourceKey);
  }, [sourceKey]);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"content" | "filename">("content");
  const searchSourceKey = requestSourceKey(sourceKey, searchQuery.trim(), searchMode);
  const [searchState, setSearchState] = useState<FileTreeSearchState>(() => ({
    sourceKey: searchSourceKey,
    results: [],
    searching: false,
  }));
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    const requestGate = requestGateRef.current;
    if (!requestGate) return;
    const request = requestGate.issue(dirPath);

    setLoading((prev) => new Set(prev).add(dirPath));
    setErrors((prev) => {
      if (!prev.has(dirPath)) return prev;
      const next = new Map(prev);
      next.delete(dirPath);
      return next;
    });
    try {
      const entries = await readFileTreeDirectory(dashboardBackend.files, hostId, dirPath);
      if (!requestGate.isCurrent(request)) return;
      setDirContents((prev) => {
        const next = new Map(prev);
        next.set(dirPath, entries);
        return next;
      });
    } catch (error) {
      if (!requestGate.isCurrent(request)) return;
      setDirContents((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Map(prev);
        next.delete(dirPath);
        return next;
      });
      setErrors((prev) => new Map(prev).set(dirPath, fileTreeErrorMessage(error)));
    } finally {
      if (!requestGate.isCurrent(request)) return;
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [dashboardBackend.files, hostId]);

  useEffect(() => {
    setExpandedDirs(new Set());
    setDirContents(new Map());
    setLoading(new Set());
    setErrors(new Map());
    setSearchOpen(false);
    setSearchQuery("");
    setSearchState({
      sourceKey: requestSourceKey(sourceKey, "", null),
      results: [],
      searching: false,
    });
    loadDir(root);
  }, [sourceKey, root, loadDir]);

  const toggleDir = useCallback(
    (dirPath: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          if (!dirContents.has(dirPath)) {
            loadDir(dirPath);
          }
        }
        return next;
      });
    },
    [dirContents, loadDir],
  );

  useEffect(() => {
    const requestGate = searchRequestGateRef.current;
    if (!searchOpen || isRemote || !searchQuery.trim()) {
      requestGate.invalidate();
      setSearchState({ sourceKey: searchSourceKey, results: [], searching: false });
      return;
    }

    const request = requestGate.issue(searchSourceKey);
    setSearchState((current) => ({
      sourceKey: searchSourceKey,
      results: current.sourceKey === searchSourceKey ? current.results : [],
      searching: true,
    }));
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      void dashboardBackend.files.search(root, searchQuery.trim(), searchMode)
        .then((results) => {
          if (!requestGate.isCurrent(request)) return;
          setSearchState({ sourceKey: searchSourceKey, results, searching: false });
        })
        .catch(() => {
          if (!requestGate.isCurrent(request)) return;
          setSearchState({ sourceKey: searchSourceKey, results: [], searching: false });
        });
    }, 300);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      requestGate.cancel(request);
    };
  }, [
    dashboardBackend.files,
    isRemote,
    root,
    searchMode,
    searchOpen,
    searchQuery,
    searchSourceKey,
  ]);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const toggleSearch = () => {
    if (isRemote) return;
    setSearchOpen((v) => {
      if (v) {
        setSearchQuery("");
        setSearchState({ sourceKey: searchSourceKey, results: [], searching: false });
      }
      return !v;
    });
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setSearchOpen(false);
      setSearchQuery("");
      setSearchState({ sourceKey: searchSourceKey, results: [], searching: false });
    }
  };

  const renderEntries = (parentPath: string, depth: number): React.ReactNode[] => {
    const entries = dirContents.get(parentPath);
    if (!entries) {
      if (loading.has(parentPath)) {
        return [
          <div key={`loading-${parentPath}`} className="file-tree__loading" style={{ paddingLeft: depth * INDENT_PX + 12 }}>
            loading...
          </div>,
        ];
      }
      const error = errors.get(parentPath);
      if (error) {
        return [
          <div
            key={`error-${parentPath}`}
            className="file-tree__loading file-tree__loading--error"
            style={{ paddingLeft: depth * INDENT_PX + 12 }}
            role="alert"
          >
            <span>couldn&apos;t load folder: {error}</span>{" "}
            <button
              type="button"
              className="btn btn--ghost file-tree__retry"
              onClick={() => loadDir(parentPath)}
            >
              retry
            </button>
          </div>,
        ];
      }
      return [];
    }

    const filtered = showHidden ? entries : entries.filter((e) => !e.is_hidden);
    if (filtered.length === 0) {
      return [
        <div
          key={`empty-${parentPath}`}
          className="file-tree__loading file-tree__loading--empty"
          style={{ paddingLeft: depth * INDENT_PX + 12 }}
        >
          {entries.length === 0 ? "empty folder" : "no visible files"}
        </div>,
      ];
    }
    const nodes: React.ReactNode[] = [];

    for (const entry of filtered) {
      const isExpanded = expandedDirs.has(entry.path);
      const isSelected = selectedFile === entry.path;

      nodes.push(
        <div
          key={entry.path}
          className={`file-tree__item${isSelected ? " file-tree__item--selected" : ""}${entry.is_dir ? " file-tree__item--dir" : ""}`}
          style={{ paddingLeft: depth * INDENT_PX + 12 }}
          onClick={(e) => {
            e.stopPropagation();
            if (entry.is_dir) {
              toggleDir(entry.path);
            } else {
              onFileSelect(entry.path, hostId);
            }
          }}
          role="button"
          aria-expanded={entry.is_dir ? isExpanded : undefined}
          aria-current={!entry.is_dir && isSelected ? "true" : undefined}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (entry.is_dir) toggleDir(entry.path);
              else onFileSelect(entry.path, hostId);
            }
          }}
        >
          <span className="file-tree__chevron">
            {entry.is_dir ? (
              isExpanded
                ? <ChevronDown size={10} strokeWidth={1.5} aria-hidden="true" />
                : <ChevronRight size={10} strokeWidth={1.5} aria-hidden="true" />
            ) : null}
          </span>
          <span className="file-tree__icon">
            {entry.is_dir
              ? <Folder size={15} strokeWidth={1.4} aria-hidden="true" />
              : <File size={15} strokeWidth={1.4} aria-hidden="true" />}
          </span>
          <span className="file-tree__name" title={entry.name}>
            {entry.name}
          </span>
        </div>,
      );

      if (entry.is_dir && isExpanded) {
        nodes.push(...renderEntries(entry.path, depth + 1));
      }
    }

    return nodes;
  };

  const renderSearchResults = () => {
    const currentSearchState = searchState.sourceKey === searchSourceKey
      ? searchState
      : {
          sourceKey: searchSourceKey,
          results: [],
          searching: searchOpen && !isRemote && !!searchQuery.trim(),
        };
    const { results: searchResults, searching } = currentSearchState;
    if (searching) {
      return <div className="file-tree__loading" style={{ paddingLeft: 12 }}>searching...</div>;
    }
    if (!searchQuery.trim()) {
      return <div className="file-tree__loading" style={{ paddingLeft: 12 }}>type to search</div>;
    }
    if (searchResults.length === 0) {
      return <div className="file-tree__loading" style={{ paddingLeft: 12 }}>no results</div>;
    }

    return searchResults.map((r, i) => {
      const relPath = r.path.startsWith(root) ? r.path.slice(root.length + 1) : r.path;
      return (
        <div
          key={`${r.path}:${r.line_number ?? 0}:${i}`}
          className="file-tree__item file-tree__search-result"
          onClick={() => onFileSelect(r.path, hostId)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onFileSelect(r.path, hostId);
          }}
        >
          {searchMode === "content" ? (
            <div className="search-result__content">
              <span className="search-result__file">{relPath}</span>
              <span className="search-result__line-num">:{r.line_number}</span>
              <div className="search-result__text">{r.line_content}</div>
            </div>
          ) : (
            <div className="search-result__content">
              <span className="search-result__icon">
                <File size={15} strokeWidth={1.4} aria-hidden="true" />
              </span>
              <span className="search-result__path">{relPath}</span>
            </div>
          )}
        </div>
      );
    });
  };

  const rootName = root.split("/").filter(Boolean).pop() ?? root;

  return (
    <div className="file-tree">
      <div className="file-tree__header">
        <span className="pane__title" title={root}>{rootName}</span>
        {isRemote && (
          <span className="file-tree__remote-note">Remote browse only</span>
        )}
        <button
          className={`file-tree__search-btn${searchOpen && !isRemote ? " file-tree__search-btn--active" : ""}`}
          onClick={toggleSearch}
          title={isRemote ? "Search is not available for remote files yet" : "search (⌘F)"}
          aria-label={isRemote ? "Search unavailable for remote files" : "Search files"}
          disabled={isRemote}
          type="button"
        >
          <Search size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      {searchOpen && !isRemote && (
        <div className="file-tree__search-panel">
          <input
            ref={searchInputRef}
            className="file-tree__search-input"
            type="text"
            placeholder={searchMode === "content" ? "Search in files..." : "Search file name..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            spellCheck={false}
          />
          <div className="file-tree__search-tabs">
            <button
              className={`file-tree__search-tab${searchMode === "content" ? " file-tree__search-tab--active" : ""}`}
              onClick={() => setSearchMode("content")}
              type="button"
            >
              content
            </button>
            <button
              className={`file-tree__search-tab${searchMode === "filename" ? " file-tree__search-tab--active" : ""}`}
              onClick={() => setSearchMode("filename")}
              type="button"
            >
              filename
            </button>
          </div>
        </div>
      )}
      <div className="file-tree__list">
        {searchOpen && !isRemote ? renderSearchResults() : renderEntries(root, 0)}
      </div>
    </div>
  );
}
