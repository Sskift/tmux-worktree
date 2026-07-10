import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import { keepFocusInside } from "./dashboard/Settings/focusTrap";
import { createLatestRequestGate, requestSourceKey } from "./latestRequestGate";
import { MenuSelect, type MenuOption } from "./MenuSelect";
import { type HostConfig, useDashboardBackend } from "./platform";
import { RemoteDirectoryPicker } from "./RemoteDirectoryPicker";

export type TerminalDraft = {
  label: string;
  cwd: string;
  aiCmd: string;
  hostId?: string | null;
};

type Props = {
  hosts: HostConfig[];
  existingLabels?: string[];
  onClose: () => void;
  onCreated: (draft: TerminalDraft) => Promise<void> | void;
};

const LOCAL_HOST = "__local__";

export function NewTerminalModal({ hosts, existingLabels = [], onClose, onCreated }: Props) {
  const dashboardBackend = useDashboardBackend();
  const dialogRef = useRef<HTMLFormElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const remoteBrowseButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const homeDirectoryRequestGateRef = useRef(createLatestRequestGate());
  const homeDefaultPublishGateRef = useRef(createLatestRequestGate());
  const titleId = useId();
  const descriptionId = useId();
  const [selectedHost, setSelectedHost] = useState(LOCAL_HOST);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [aiCmd, setAiCmd] = useState(loadLastAiCmd);
  const [localDefaultPath, setLocalDefaultPath] = useState("");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRemote = selectedHost !== LOCAL_HOST;
  const hostMenuOptions: MenuOption[] = [
    { value: LOCAL_HOST, label: "Local", detail: "this Mac" },
    ...hosts.map((host) => ({
      value: host.id,
      label: host.label,
      detail: host.host,
    })),
  ];

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const animationFrame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(animationFrame);
      const focusTarget = previousFocusRef.current;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, []);

  useEffect(() => {
    const requestGate = homeDirectoryRequestGateRef.current;
    const publishGate = homeDefaultPublishGateRef.current;
    const sourceKey = requestSourceKey("new-terminal-home-directory", LOCAL_HOST);
    const requestToken = requestGate.issue(sourceKey);
    const publishToken = publishGate.issue(sourceKey);

    void dashboardBackend.persistence.homeDirectory()
      .then((home) => {
        if (!requestGate.isCurrent(requestToken)) return;
        const desktop = `${home}/Desktop`;
        setLocalDefaultPath(desktop);
        if (!publishGate.isCurrent(publishToken)) return;
        setPath(desktop);
        setLabel("Desktop");
      })
      .catch(() => {});

    return () => {
      requestGate.cancel(requestToken);
      publishGate.cancel(publishToken);
    };
  }, [dashboardBackend]);

  const invalidatePendingHomeDefault = () => {
    homeDefaultPublishGateRef.current.invalidate();
  };

  const changeHost = (hostId: string) => {
    invalidatePendingHomeDefault();
    setSelectedHost(hostId);
    setError(null);
    if (hostId === LOCAL_HOST) {
      if (!path.trim()) setPath(localDefaultPath);
      if (!label.trim()) setLabel("Desktop");
    } else {
      setPath("");
      setLabel("");
    }
  };

  const browse = async () => {
    invalidatePendingHomeDefault();
    try {
      const picked = await dashboardBackend.dialog.selectDirectory({
        title: "Select directory",
      });
      if (typeof picked === "string") {
        setPath(picked);
        if (!label.trim()) {
          setLabel(picked.split("/").filter(Boolean).pop() ?? "");
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    const ai = aiCmd.trim();
    if (!p) {
      setError(isRemote ? "remote path required" : "directory required");
      return;
    }
    if (!ai) {
      setError("ai command required");
      return;
    }
    const l = label.trim() || p.split("/").filter(Boolean).pop() || "terminal";
    if (existingLabels.includes(l)) {
      setError(`A terminal named "${l}" already exists`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreated({
        label: l,
        cwd: p,
        aiCmd: ai,
        hostId: isRemote ? selectedHost : null,
      });
      saveLastAiCmd(ai);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }

    if (dialogRef.current) keepFocusInside(event.nativeEvent, dialogRef.current);
  };

  return (
    <div className="modal-backdrop">
      <form
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        aria-hidden={showRemotePicker ? true : undefined}
        inert={showRemotePicker}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        onSubmit={submit}
      >
        <div className="modal__title" id={titleId}>new terminal</div>
        <p className="modal__hint" id={descriptionId}>
          Create a TW-managed tmux session and start the AI command in it.
        </p>

        {hosts.length > 0 && (
          <label className="field">
            <span className="field__label">host</span>
            <MenuSelect
              ariaLabel="Host"
              value={selectedHost}
              options={hostMenuOptions}
              onChange={changeHost}
              disabled={busy}
            />
          </label>
        )}

        <label className="field">
          <span className="field__label">{isRemote ? "remote path" : "directory"}</span>
          <div className="field__row">
            <input
              ref={initialFocusRef}
              className="field__input"
              type="text"
              value={path}
              onChange={(e) => {
                invalidatePendingHomeDefault();
                setPath(e.target.value);
                if (!label.trim()) {
                  setLabel(e.target.value.split("/").filter(Boolean).pop() ?? "");
                }
              }}
              placeholder={isRemote ? "/path/on/host" : "/path/to/dir"}
              disabled={busy}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              ref={remoteBrowseButtonRef}
              type="button"
              className="btn btn--ghost"
              onClick={() => isRemote ? setShowRemotePicker(true) : browse()}
              disabled={busy}
            >
              browse
            </button>
          </div>
        </label>

        <label className="field">
          <span className="field__label">ai command</span>
          <input
            className="field__input"
            type="text"
            value={aiCmd}
            onChange={(e) => setAiCmd(e.target.value)}
            placeholder="claude"
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span className="field__label">label</span>
          <input
            className="field__input"
            type="text"
            value={label}
            onChange={(e) => {
              invalidatePendingHomeDefault();
              setLabel(e.target.value);
            }}
            placeholder="(optional, defaults to directory name)"
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>

        {error && <div className="modal__error">{error}</div>}

        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            cancel
          </button>
          <button
            type="submit"
            className="btn btn--accent"
            disabled={busy || !path.trim() || !aiCmd.trim()}
          >
            {busy ? "creating..." : isRemote ? "create on host" : "create"}
          </button>
        </div>
      </form>
      {showRemotePicker && isRemote && (
        <RemoteDirectoryPicker
          hostId={selectedHost}
          initialPath={path}
          returnFocusRef={remoteBrowseButtonRef}
          onClose={() => setShowRemotePicker(false)}
          onSelect={(pickedPath) => {
            invalidatePendingHomeDefault();
            setPath(pickedPath);
            if (!label.trim()) {
              setLabel(pickedPath.split("/").filter(Boolean).pop() ?? "");
            }
            setShowRemotePicker(false);
          }}
        />
      )}
    </div>
  );
}
