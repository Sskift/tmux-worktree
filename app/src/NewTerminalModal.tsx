import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import { MenuSelect, type MenuOption } from "./MenuSelect";
import { RemoteDirectoryPicker } from "./RemoteDirectoryPicker";

type HostConfig = {
  id: string;
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
};

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
    invoke<string>("home_dir")
      .then((home) => {
        const desktop = `${home}/Desktop`;
        setLocalDefaultPath(desktop);
        setPath(desktop);
        setLabel("Desktop");
      })
      .catch(() => {});
  }, []);

  const changeHost = (hostId: string) => {
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
    try {
      const picked = await open({
        directory: true,
        multiple: false,
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

  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal__title">new terminal</div>
        <p className="modal__hint">
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
              className="field__input"
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                if (!label.trim()) {
                  setLabel(e.target.value.split("/").filter(Boolean).pop() ?? "");
                }
              }}
              placeholder={isRemote ? "/path/on/host" : "/path/to/dir"}
              disabled={busy}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => isRemote ? setShowRemotePicker(true) : browse()}
              disabled={busy}
            >
              browse
            </button>
          </div>
        </label>

        {showRemotePicker && isRemote && (
          <RemoteDirectoryPicker
            hostId={selectedHost}
            initialPath={path}
            onClose={() => setShowRemotePicker(false)}
            onSelect={(pickedPath) => {
              setPath(pickedPath);
              if (!label.trim()) {
                setLabel(pickedPath.split("/").filter(Boolean).pop() ?? "");
              }
              setShowRemotePicker(false);
            }}
          />
        )}

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
            onChange={(e) => setLabel(e.target.value)}
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
    </div>
  );
}
