import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  is_hidden: boolean;
  size: number;
};

type SearchResult = {
  path: string;
  file_name: string;
  line_number: number | null;
  line_content: string | null;
};

type Props = {
  root: string;
  selectedFile: string | null;
  onFileSelect: (path: string) => void;
  showHidden?: boolean;
};

const INDENT_PX = 20;

const ChevronRight = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ChevronDown = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M1.5 12.5V3.5C1.5 3.1 1.9 2.5 2.5 2.5H6L7.5 4H13C13.6 4 14 4.4 14 5V12.5C14 13 13.6 13.5 13 13.5H2.5C1.9 13.5 1.5 13 1.5 12.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
);

const FileIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M4 1.5H10L13 4.5V14C13 14.3 12.8 14.5 12.5 14.5H4C3.7 14.5 3.5 14.3 3.5 14V2C3.5 1.7 3.7 1.5 4 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
    <path d="M10 1.5V4.5H13" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
);

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

export function FileTree({ root, selectedFile, onFileSelect, showHidden = true }: Props) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const rootRef = useRef(root);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"content" | "filename">("content");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading((prev) => new Set(prev).add(dirPath));
    try {
      const entries = await invoke<DirEntry[]>("read_dir", { path: dirPath });
      setDirContents((prev) => {
        const next = new Map(prev);
        next.set(dirPath, entries);
        return next;
      });
    } catch {
      // silently ignore errors for inaccessible directories
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (root !== rootRef.current) {
      rootRef.current = root;
      setExpandedDirs(new Set());
      setDirContents(new Map());
    }
    loadDir(root);
  }, [root, loadDir]);

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

  // Search logic
  const doSearch = useCallback(async (query: string, mode: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const results = await invoke<SearchResult[]>("search_files", {
        root: rootRef.current,
        query: query.trim(),
        mode,
      });
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      doSearch(searchQuery, searchMode);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery, searchMode, searchOpen, doSearch]);

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const toggleSearch = () => {
    setSearchOpen((v) => {
      if (v) {
        setSearchQuery("");
        setSearchResults([]);
      }
      return !v;
    });
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults([]);
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
      return [];
    }

    const filtered = showHidden ? entries : entries.filter((e) => !e.is_hidden);
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
              onFileSelect(entry.path);
            }
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (entry.is_dir) toggleDir(entry.path);
              else onFileSelect(entry.path);
            }
          }}
        >
          <span className="file-tree__chevron">
            {entry.is_dir ? (isExpanded ? <ChevronDown /> : <ChevronRight />) : null}
          </span>
          <span className="file-tree__icon">
            {entry.is_dir ? <FolderIcon /> : <FileIcon />}
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
          onClick={() => onFileSelect(r.path)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter") onFileSelect(r.path);
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
              <span className="search-result__icon"><FileIcon /></span>
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
        <button
          className={`file-tree__search-btn${searchOpen ? " file-tree__search-btn--active" : ""}`}
          onClick={toggleSearch}
          title="search (⌘F)"
          type="button"
        >
          <SearchIcon />
        </button>
      </div>
      {searchOpen && (
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
        {searchOpen ? renderSearchResults() : renderEntries(root, 0)}
      </div>
    </div>
  );
}
