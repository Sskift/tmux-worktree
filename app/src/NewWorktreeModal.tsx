import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Project = { name: string; path: string; branch?: string | null };
type Orphan = { project: string; path: string; name: string };

type Props = {
  onClose: () => void;
  onCreated: (sessionName: string) => void;
};

const CUSTOM = "__custom__";

// Remember the last AI command across sessions so users who default to a
// non-claude tool don't have to retype it every time.
const LAST_AI_CMD_KEY = "tw-dashboard:last-ai-cmd";

function loadLastAiCmd(): string {
  try {
    return localStorage.getItem(LAST_AI_CMD_KEY)?.trim() || "claude";
  } catch {
    return "claude";
  }
}

function saveLastAiCmd(cmd: string): void {
  try {
    const trimmed = cmd.trim();
    if (trimmed) localStorage.setItem(LAST_AI_CMD_KEY, trimmed);
  } catch {
    /* ignore quota/availability errors */
  }
}

export function NewWorktreeModal({ onClose, onCreated }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [project, setProject] = useState<string>(CUSTOM);
  const [customPath, setCustomPath] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [savePreset, setSavePreset] = useState(false);
  const [aiCmd, setAiCmd] = useState<string>(loadLastAiCmd);
  const [name, setName] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<Project[]>("list_projects")
      .then((list) => {
        setProjects(list);
        if (list.length > 0) setProject(list[0].name);
      })
      .catch((e) => setError(String(e)));
    invoke<Orphan[]>("list_orphaned_worktrees")
      .then(setOrphans)
      .catch(() => {});
  }, []);

  const isCustom = project === CUSTOM;

  const browse = async () => {
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "Select project directory",
      });
      if (typeof picked === "string") {
        setCustomPath(picked);
        if (!customName.trim()) {
          const base = picked.split("/").filter(Boolean).pop() ?? "";
          setCustomName(base);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const restoreOrphan = async (orphan: Orphan) => {
    setBusy(true);
    setError(null);
    try {
      const sessionName = await invoke<string>("restore_worktree", {
        args: { path: orphan.path, name: orphan.name, aiCmd: aiCmd.trim() || "" },
      });
      saveLastAiCmd(aiCmd);
      onCreated(sessionName);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  const deleteOrphan = async (orphan: Orphan) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("delete_worktree", {
        args: { path: orphan.path, force: false },
      });
      setOrphans((prev) => prev.filter((item) => item.path !== orphan.path));
    } catch (err) {
      const message = String(err);
      if (!message.includes("uncommitted changes")) {
        setError(message);
        setBusy(false);
        return;
      }
      const confirmed = window.confirm(
        `Worktree "${orphan.name}" has uncommitted changes. Delete it anyway?`,
      );
      if (!confirmed) {
        setBusy(false);
        return;
      }
      try {
        await invoke("delete_worktree", {
          args: { path: orphan.path, force: true },
        });
        setOrphans((prev) => prev.filter((item) => item.path !== orphan.path));
      } catch (forceErr) {
        setError(String(forceErr));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiCmd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const createArgs: {
        project?: string;
        path?: string;
        aiCmd: string;
        name: string | null;
        branch?: string;
      } = {
        aiCmd: aiCmd.trim(),
        name: name.trim() || null,
      };

      if (isCustom) {
        const path = customPath.trim();
        if (!path) throw new Error("path required");
        if (savePreset) {
          const presetName = customName.trim();
          if (!presetName) throw new Error("preset name required");
          await invoke<Project[]>("add_project", {
            args: { name: presetName, path },
          });
          createArgs.project = presetName;
        } else {
          createArgs.path = path;
        }
      } else {
        createArgs.project = project;
      }
      if (branch.trim()) {
        createArgs.branch = branch.trim();
      }

      const sessionName = await invoke<string>("create_worktree", {
        args: createArgs,
      });
      saveLastAiCmd(aiCmd);
      onCreated(sessionName);
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
        <div className="modal__title">new worktree</div>

        {orphans.length > 0 && (
          <div className="field">
            <span className="field__label">restore existing</span>
            <div className="orphan-list">
              {orphans.map((o) => (
                <div key={o.path} className="orphan-row">
                  <button
                    type="button"
                    className="btn btn--ghost orphan-item"
                    disabled={busy}
                    onClick={() => restoreOrphan(o)}
                  >
                    <span className="orphan-item__project">{o.project}</span>
                    <span className="orphan-item__sep">/</span>
                    <span className="orphan-item__name">{o.name}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost orphan-delete"
                    disabled={busy}
                    onClick={() => deleteOrphan(o)}
                    title={`delete ${o.name}`}
                    aria-label={`delete ${o.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {orphans.length > 0 && (
          <div className="modal__divider">or create new</div>
        )}

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
                {p.name} — {p.path}
              </option>
            ))}
            <option value={CUSTOM}>+ custom path…</option>
          </select>
        </label>

        {isCustom && (
          <>
            <label className="field">
              <span className="field__label">path</span>
              <div className="field__row">
                <input
                  className="field__input"
                  type="text"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder="/path/to/repo"
                  disabled={busy}
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

            <label className="checkbox">
              <input
                type="checkbox"
                checked={savePreset}
                onChange={(e) => setSavePreset(e.target.checked)}
                disabled={busy}
              />
              <span>save to ~/.tmux-worktree.json for reuse</span>
            </label>

            {savePreset && (
              <label className="field">
                <span className="field__label">preset name</span>
                <input
                  className="field__input"
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="short id, used as session prefix"
                  disabled={busy}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            )}
          </>
        )}

        <label className="field">
          <span className="field__label">target branch</span>
          <input
            className="field__input"
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={
              !isCustom && projects.find((p) => p.name === project)?.branch
                ? `default: ${projects.find((p) => p.name === project)?.branch}`
                : "auto-detect origin HEAD"
            }
            disabled={busy}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
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
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
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
            disabled={
              busy ||
              !aiCmd.trim() ||
              (isCustom &&
                (!customPath.trim() ||
                  (savePreset && !customName.trim())))
            }
          >
            {busy ? "creating…" : "create"}
          </button>
        </div>
      </form>
    </div>
  );
}
