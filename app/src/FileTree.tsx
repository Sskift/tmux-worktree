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

export function FileTree({ root, selectedFile, onFileSelect, showHidden = false }: Props) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirContents, setDirContents] = useState<Map<string, DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const rootRef = useRef(root);

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

  const rootName = root.split("/").filter(Boolean).pop() ?? root;

  return (
    <div className="file-tree">
      <div className="section-label file-tree__header">
        <span className="section-label__text" title={root}>{rootName}</span>
        <span className="section-label__line" />
      </div>
      <div className="file-tree__list">
        {renderEntries(root, 0)}
      </div>
    </div>
  );
}
