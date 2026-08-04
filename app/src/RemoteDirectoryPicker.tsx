import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Folder } from "lucide-react";
import { keepFocusInside } from "./dashboard/Settings/focusTrap";
import type { DirEntry } from "./FileTree";
import { useDashboardBackend } from "./platform";

type Props = {
  hostId: string;
  initialPath?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (path: string) => void;
};

function parentRemotePath(path: string) {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

export function RemoteDirectoryPicker({
  hostId,
  initialPath,
  returnFocusRef,
  onClose,
  onSelect,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const dialogRef = useRef<HTMLElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const [pathInput, setPathInput] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loadingHome, setLoadingHome] = useState(false);
  const [loadingDir, setLoadingDir] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = loadingHome || loadingDir;

  useEffect(() => {
    previousFocusRef.current = returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    return () => {
      const focusTarget = previousFocusRef.current;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (loadingHome) return;
    const animationFrame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [loadingHome]);

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
    dashboardBackend.hosts.remoteHome(hostId)
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
    dashboardBackend.files.readRemoteDirectory(hostId, path)
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

  const handlePathKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      goToPath(pathInput);
    }
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (dialogRef.current) keepFocusInside(event.nativeEvent, dialogRef.current);
  };

  const selectedPath = (currentPath || pathInput).trim();

  return (
    <div className="modal-backdrop modal-backdrop--nested" onClick={onClose}>
      <section
        ref={dialogRef}
        className="modal remote-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="modal__title" id={titleId}>select remote directory</div>

        <label className="field">
          <span className="field__label">remote path</span>
          <div className="remote-picker__path-row">
            <input
              ref={initialFocusRef}
              className="field__input"
              type="text"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              onKeyDown={handlePathKeyDown}
              disabled={loadingHome}
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
                  <Folder size={14} strokeWidth={1.5} aria-hidden="true" />
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
