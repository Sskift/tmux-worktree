import { useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "./FileTree";

type Props = {
  hostId: string;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M1.5 12.5V3.5C1.5 3.1 1.9 2.5 2.5 2.5H6L7.5 4H13C13.6 4 14 4.4 14 5V12.5C14 13 13.6 13.5 13 13.5H2.5C1.9 13.5 1.5 13 1.5 12.5Z"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinejoin="round"
    />
  </svg>
);

function parentRemotePath(path: string) {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

export function RemoteDirectoryPicker({ hostId, initialPath, onClose, onSelect }: Props) {
  const [pathInput, setPathInput] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingHome, setLoadingHome] = useState(false);
  const [loadingDir, setLoadingDir] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = loadingHome || loadingDir;

  const goToPath = (nextPath: string) => {
    const trimmed = nextPath.trim();
    if (!trimmed) return;
    setPathInput(trimmed);
    setCurrentPath(trimmed);
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries([]);

    const initial = initialPath?.trim();
    if (initial) {
      setPathInput(initial);
      setCurrentPath(initial);
      return () => {
        cancelled = true;
      };
    }

    setLoadingHome(true);
    invoke<string>("remote_home_dir", { hostId })
      .then((home) => {
        if (cancelled) return;
        const nextPath = home.trim() || "/";
        setPathInput(nextPath);
        setCurrentPath(nextPath);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingHome(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, initialPath]);

  useEffect(() => {
    const path = currentPath.trim();
    if (!path) return;
    let cancelled = false;
    setLoadingDir(true);
    setError(null);
    invoke<DirEntry[]>("remote_read_dir", { hostId, path })
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries([]);
          setError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDir(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, currentPath]);

  const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToPath(pathInput);
    }
  };

  const selectedPath = (currentPath || pathInput).trim();

  return (
    <div className="modal-backdrop modal-backdrop--nested" onClick={onClose}>
      <section
        className="modal remote-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Select remote directory"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__title">select remote directory</div>

        <label className="field">
          <span className="field__label">remote path</span>
          <div className="remote-picker__path-row">
            <input
              className="field__input"
              type="text"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={handlePathKeyDown}
              disabled={loadingHome}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => goToPath(parentRemotePath(selectedPath))}
              disabled={loading || selectedPath === "/"}
            >
              up
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => goToPath(pathInput)}
              disabled={loadingHome || !pathInput.trim()}
            >
              go
            </button>
          </div>
        </label>

        <div className="remote-picker__list" role="listbox" aria-label="Remote directories">
          {loadingDir && <div className="remote-picker__empty">loading...</div>}
          {!loadingDir && entries.length === 0 && (
            <div className="remote-picker__empty">no directories</div>
          )}
          {!loadingDir &&
            entries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                className="remote-picker__item"
                onClick={() => goToPath(entry.path)}
              >
                <span className="remote-picker__icon">
                  <FolderIcon />
                </span>
                <span className="remote-picker__name">{entry.name}</span>
                <span className="remote-picker__path">{entry.path}</span>
              </button>
            ))}
        </div>

        {error && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            cancel
          </button>
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => onSelect(selectedPath)}
            disabled={!selectedPath}
          >
            select
          </button>
        </div>
      </section>
    </div>
  );
}
