import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

type Props = {
  existingLabels?: string[];
  onClose: () => void;
  onCreated: (label: string, cwd: string) => void;
};

export function NewTerminalModal({ existingLabels = [], onClose, onCreated }: Props) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!p) return;
    const l = label.trim() || p.split("/").filter(Boolean).pop() || "terminal";
    if (existingLabels.includes(l)) {
      setError(`A terminal named "${l}" already exists`);
      return;
    }
    setBusy(true);
    setError(null);
    onCreated(l, p);
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal__title">new terminal</div>
        <p className="modal__hint">
          Open a plain zsh shell in the specified directory.
        </p>

        <label className="field">
          <span className="field__label">directory</span>
          <div className="field__row">
            <input
              className="field__input"
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/dir"
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
              onClick={browse}
              disabled={busy}
            >
              browse
            </button>
          </div>
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
            disabled={busy || !path.trim()}
          >
            create
          </button>
        </div>
      </form>
    </div>
  );
}
