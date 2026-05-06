import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Project = { name: string; path: string };

type Props = {
  onClose: () => void;
  onCreated: (sessionName: string) => void;
};

export function NewWorktreeModal({ onClose, onCreated }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>("");
  const [aiCmd, setAiCmd] = useState<string>("claude");
  const [name, setName] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Project[]>("list_projects")
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setProject(list[0].name);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project || !aiCmd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const sessionName = await invoke<string>("create_worktree", {
        args: { project, aiCmd: aiCmd.trim(), name: name.trim() || null },
      });
      onCreated(sessionName);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="modal__title">new worktree</div>

        {projects.length === 0 ? (
          <div className="modal__hint">
            no projects in <code>~/.tmux-worktree.json</code>
          </div>
        ) : (
          <>
            <label className="field">
              <span className="field__label">project</span>
              <select
                className="field__input"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                disabled={busy}
              >
                {projects.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
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
                autoFocus
              />
            </label>

            <label className="field">
              <span className="field__label">session name</span>
              <input
                className="field__input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="(optional, defaults to project)"
                disabled={busy}
              />
            </label>
          </>
        )}

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
            disabled={busy || projects.length === 0 || !project}
          >
            {busy ? "creating…" : "create"}
          </button>
        </div>
      </form>
    </div>
  );
}
