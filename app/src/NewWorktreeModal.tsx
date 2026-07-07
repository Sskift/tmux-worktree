import { useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import { MenuSelect, type MenuOption } from "./MenuSelect";
import { RemoteDirectoryPicker } from "./RemoteDirectoryPicker";

type Project = { name: string; path: string; branch?: string | null };
type Orphan = { project: string; path: string; name: string };
type HostConfig = {
  id: string;
  label: string;
  host: string;
  user?: string | null;
  port?: number | null;
  identityFile?: string | null;
};

type Props = {
  hosts: HostConfig[];
  onClose: () => void;
  onCreated: (sessionName: string) => void;
};

const CUSTOM = "__custom__";
const LOCAL_HOST = "__local__";

export function NewWorktreeModal({ hosts, onClose, onCreated }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>(LOCAL_HOST);
  const [project, setProject] = useState<string>(CUSTOM);
  const [customPath, setCustomPath] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [savePreset, setSavePreset] = useState(false);
  const [aiCmd, setAiCmd] = useState<string>(loadLastAiCmd);
  const [name, setName] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRemote = selectedHost !== LOCAL_HOST;
  const isCustom = project === CUSTOM;
  const hostMenuOptions: MenuOption[] = [
    { value: LOCAL_HOST, label: "Local", detail: "this Mac" },
    ...hosts.map((host) => ({
      value: host.id,
      label: host.label,
      detail: host.host,
    })),
  ];
  const projectMenuOptions: MenuOption[] = [
    ...projects.map((p) => ({
      value: p.name,
      label: p.name,
      detail: `${p.path}${p.branch ? ` @ ${p.branch}` : ""}`,
    })),
    {
      value: CUSTOM,
      label: "+ custom path...",
      detail: "choose another repository",
    },
  ];

  useEffect(() => {
    if (!isRemote) {
      invoke<Project[]>("list_projects")
        .then((list) => {
          setProjects(list);
          setProject(list.length > 0 ? list[0].name : CUSTOM);
        })
        .catch((e) => setError(String(e)));
      invoke<Orphan[]>("list_orphaned_worktrees")
        .then(setOrphans)
        .catch(() => {});
    } else {
      setOrphans([]);
      invoke<Project[]>("list_remote_projects", { hostId: selectedHost })
        .then((list) => {
          setProjects(list);
          setProject(list.length > 0 ? list[0].name : CUSTOM);
        })
        .catch((e) => {
          setProjects([]);
          setProject(CUSTOM);
          setError(String(e));
        });
    }
  }, [isRemote, selectedHost]);

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
    const confirmed = window.confirm(
      `Delete worktree "${orphan.name}"? This will discard any uncommitted changes.`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      await invoke("delete_worktree", {
        args: { path: orphan.path, force: true },
      });
      setOrphans((prev) => prev.filter((item) => item.path !== orphan.path));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
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
        hostId?: string;
      } = {
        aiCmd: aiCmd.trim(),
        name: name.trim() || null,
      };

      if (isRemote) {
        createArgs.hostId = selectedHost;
        if (isCustom) {
          const path = customPath.trim();
          if (!path) throw new Error("remote path required");
          createArgs.path = path;
        } else {
          createArgs.project = project;
        }
      } else if (isCustom) {
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

        {orphans.length > 0 && !isRemote && (
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

        {orphans.length > 0 && !isRemote && (
          <div className="modal__divider">or create new</div>
        )}

        {hosts.length > 0 && (
          <label className="field">
            <span className="field__label">host</span>
            <MenuSelect
              ariaLabel="Host"
              value={selectedHost}
              options={hostMenuOptions}
              onChange={setSelectedHost}
              disabled={busy}
            />
          </label>
        )}

        {(!isRemote || projects.length > 0) && (
          <label className="field">
            <span className="field__label">project</span>
            <MenuSelect
              ariaLabel="Project"
              value={project}
              options={projectMenuOptions}
              onChange={setProject}
              disabled={busy}
            />
          </label>
        )}

        {isCustom && (
          <>
            <label className="field">
              <span className="field__label">{isRemote ? "remote path" : "path"}</span>
              <div className="field__row">
                <input
                  className="field__input"
                  type="text"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder={isRemote ? "/path/to/repo/on/remote" : "/path/to/repo"}
                  disabled={busy}
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

            {!isRemote && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={savePreset}
                onChange={(e) => setSavePreset(e.target.checked)}
                disabled={busy}
              />
              <span>save to ~/.tmux-worktree.json for reuse</span>
            </label>
            )}

            {savePreset && !isRemote && (
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

        {showRemotePicker && isRemote && (
          <RemoteDirectoryPicker
            hostId={selectedHost}
            initialPath={customPath}
            onClose={() => setShowRemotePicker(false)}
            onSelect={(path) => {
              setCustomPath(path);
              if (!customName.trim()) {
                setCustomName(path.split("/").filter(Boolean).pop() ?? "");
              }
              setShowRemotePicker(false);
            }}
          />
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
                  (!isRemote && savePreset && !customName.trim())))
            }
          >
            {busy ? "creating…" : isRemote ? "create on remote" : "create"}
          </button>
        </div>
      </form>
    </div>
  );
}
