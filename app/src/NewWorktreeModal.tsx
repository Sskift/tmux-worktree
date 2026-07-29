import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";
import type {
  WorkspaceCreateWorktreeRequest,
} from "./dashboard/actions/workspaceActionCoordinator";
import { keepFocusInside } from "./dashboard/Settings/focusTrap";
import { createLatestRequestGate, requestSourceKey } from "./latestRequestGate";
import { MenuSelect, type MenuOption } from "./MenuSelect";
import {
  type AgentProbeResult,
  type CreateWorktreeInput,
  type HostConfig,
  type OrphanedWorktree as Orphan,
  type ProjectPreset as Project,
  type RestoreWorktreeInput,
  useDashboardBackend,
} from "./platform";
import { RemoteDirectoryPicker } from "./RemoteDirectoryPicker";

type Props = {
  hosts: HostConfig[];
  onClose: () => void;
  onCreateWorktree(request: WorkspaceCreateWorktreeRequest): Promise<boolean>;
  onRestoreWorktree(args: RestoreWorktreeInput): Promise<boolean>;
  onDeleteWorktree(orphan: Orphan): Promise<boolean>;
};

const CUSTOM = "__custom__";
const LOCAL_HOST = "__local__";

export type WorktreeCatalogDraftState = Readonly<{
  source: string;
  dirty: boolean;
}>;

export function shouldApplyWorktreeCatalogDefault(
  draftState: WorktreeCatalogDraftState,
  source: string,
): boolean {
  return draftState.source === source && !draftState.dirty;
}

export function availableWorktreeAgents(
  results: readonly AgentProbeResult[],
): AgentProbeResult[] {
  return results.filter((agent) => agent.available);
}

export function resolveWorktreeAgentCommand(
  results: readonly AgentProbeResult[],
  preferredCommand: string,
): string {
  const available = availableWorktreeAgents(results);
  const preferred = preferredCommand.trim();
  return available.some((agent) => agent.command === preferred)
    ? preferred
    : available[0]?.command ?? "";
}

export type WorktreeAgentAvailability = Readonly<{
  source: string;
  results: readonly AgentProbeResult[];
}>;

export function isWorktreeAgentSelectionAvailable(
  availability: WorktreeAgentAvailability,
  source: string,
  command: string,
): boolean {
  const selected = command.trim();
  return availability.source === source && availability.results.some(
    (agent) => agent.available && agent.command === selected,
  );
}

export function NewWorktreeModal({
  hosts,
  onClose,
  onCreateWorktree,
  onRestoreWorktree,
  onDeleteWorktree,
}: Props) {
  const dashboardBackend = useDashboardBackend();
  const dialogRef = useRef<HTMLFormElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const remoteBrowseButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const catalogRequestGateRef = useRef(createLatestRequestGate());
  const agentRequestGateRef = useRef(createLatestRequestGate());
  const agentAvailabilityRef = useRef<WorktreeAgentAvailability>({
    source: LOCAL_HOST,
    results: [],
  });
  const projectValidationGateRef = useRef(createLatestRequestGate());
  const busyRef = useRef(false);
  const catalogDraftStateRef = useRef<WorktreeCatalogDraftState>({
    source: LOCAL_HOST,
    dirty: false,
  });
  const titleId = useId();
  const preferredAgentRef = useRef(loadLastAiCmd());
  const [projects, setProjects] = useState<Project[]>([]);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [selectedHost, setSelectedHost] = useState<string>(LOCAL_HOST);
  const [project, setProject] = useState<string>(CUSTOM);
  const [customPath, setCustomPath] = useState<string>("");
  const [customName, setCustomName] = useState<string>("");
  const [savePreset, setSavePreset] = useState(false);
  const [agentResults, setAgentResults] = useState<AgentProbeResult[]>([]);
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [aiCmd, setAiCmd] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [showRemotePicker, setShowRemotePicker] = useState(false);
  const [validatingProject, setValidatingProject] = useState(false);
  const [projectCatalogLoading, setProjectCatalogLoading] = useState(true);
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
  const selectedHostLabel = isRemote
    ? hosts.find((host) => host.id === selectedHost)?.label ?? selectedHost
    : "This Mac";
  const projectMenuOptions: MenuOption[] = isRemote && projectCatalogLoading
    ? [{
        value: CUSTOM,
        label: "Loading remote projects…",
        detail: `${selectedHostLabel} · ~/.tmux-worktree.json`,
      }]
    : [
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
  const agentMenuOptions: MenuOption[] = agentLoading
    ? [{ value: "", label: "Scanning agents…", detail: selectedHostLabel }]
    : agentError
      ? [{ value: "", label: "Agent scan failed", detail: selectedHostLabel }]
      : agentResults.length === 0
        ? [{ value: "", label: "No agents available", detail: selectedHostLabel }]
        : agentResults.map((agent) => ({
            value: agent.command,
            label: agent.label,
            detail: agent.command,
          }));
  const agentSelectionAvailable = isWorktreeAgentSelectionAvailable(
    { source: selectedHost, results: agentResults },
    selectedHost,
    aiCmd,
  );

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const animationFrame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(animationFrame);
      projectValidationGateRef.current.invalidate();
      const focusTarget = previousFocusRef.current;
      if (focusTarget?.isConnected) focusTarget.focus();
    };
  }, []);

  useEffect(() => {
    const requestGate = catalogRequestGateRef.current;
    if (catalogDraftStateRef.current.source !== selectedHost) {
      catalogDraftStateRef.current = { source: selectedHost, dirty: false };
    }
    const token = requestGate.issue(
      requestSourceKey("new-worktree-catalog", selectedHost),
    );
    const mayApplyCatalogDefault = shouldApplyWorktreeCatalogDefault(
      catalogDraftStateRef.current,
      selectedHost,
    );

    if (mayApplyCatalogDefault) {
      setProjects([]);
      setProject(CUSTOM);
    }
    setProjectCatalogLoading(true);
    setOrphans([]);
    setError(null);

    if (!isRemote) {
      void dashboardBackend.projects.list()
        .then((list) => {
          if (!requestGate.isCurrent(token)) return;
          setProjectCatalogLoading(false);
          setProjects(list);
          if (
            shouldApplyWorktreeCatalogDefault(catalogDraftStateRef.current, selectedHost)
          ) {
            setProject(list.length > 0 ? list[0].name : CUSTOM);
          }
        })
        .catch((e) => {
          if (!requestGate.isCurrent(token)) return;
          setProjectCatalogLoading(false);
          setError(String(e));
        });
    } else {
      void dashboardBackend.projects.listRemote(selectedHost)
        .then((list) => {
          if (!requestGate.isCurrent(token)) return;
          setProjectCatalogLoading(false);
          setProjects(list);
          if (
            shouldApplyWorktreeCatalogDefault(catalogDraftStateRef.current, selectedHost)
          ) {
            setProject(list.length > 0 ? list[0].name : CUSTOM);
          }
        })
        .catch((e) => {
          if (!requestGate.isCurrent(token)) return;
          setProjectCatalogLoading(false);
          setProjects([]);
          setProject(CUSTOM);
          setError(String(e));
        });
    }

    void dashboardBackend.worktrees.listOrphaned(isRemote ? selectedHost : undefined)
      .then((list) => {
        if (requestGate.isCurrent(token)) setOrphans(list);
      })
      .catch((e) => {
        if (requestGate.isCurrent(token)) setError(String(e));
      });

    return () => requestGate.cancel(token);
  }, [dashboardBackend, isRemote, selectedHost]);

  useEffect(() => {
    const requestGate = agentRequestGateRef.current;
    const token = requestGate.issue(
      requestSourceKey("new-worktree-agents", selectedHost),
    );
    const target = isRemote
      ? { kind: "host" as const, hostId: selectedHost }
      : { kind: "local" as const };

    setAgentLoading(true);
    setAgentResults([]);
    setAgentError(null);
    setAiCmd("");
    agentAvailabilityRef.current = { source: selectedHost, results: [] };

    void dashboardBackend.agents.probe(target).then(
      (results) => {
        if (!requestGate.isCurrent(token)) return;
        const available = availableWorktreeAgents(results);
        agentAvailabilityRef.current = { source: selectedHost, results: available };
        setAgentResults(available);
        setAiCmd(resolveWorktreeAgentCommand(available, preferredAgentRef.current));
        setAgentLoading(false);
      },
      (reason) => {
        if (!requestGate.isCurrent(token)) return;
        agentAvailabilityRef.current = { source: selectedHost, results: [] };
        setAgentError(String(reason));
        setAgentLoading(false);
      },
    );

    return () => requestGate.cancel(token);
  }, [dashboardBackend, isRemote, selectedHost]);

  const changeHost = (hostId: string) => {
    if (hostId === selectedHost) return;

    catalogRequestGateRef.current.invalidate();
    agentRequestGateRef.current.invalidate();
    projectValidationGateRef.current.invalidate();
    agentAvailabilityRef.current = { source: hostId, results: [] };
    catalogDraftStateRef.current = { source: hostId, dirty: false };
    setSelectedHost(hostId);
    setProjects([]);
    setProject(CUSTOM);
    setValidatingProject(false);
    setProjectCatalogLoading(true);
    setOrphans([]);
    setAgentLoading(true);
    setAgentResults([]);
    setAgentError(null);
    setAiCmd("");
    setError(null);
  };

  const markCatalogDraftDirty = () => {
    catalogDraftStateRef.current = { source: selectedHost, dirty: true };
  };

  const changeProject = (nextProject: string) => {
    markCatalogDraftDirty();
    projectValidationGateRef.current.invalidate();
    setProject(nextProject);
    setValidatingProject(false);
    setError(null);

    if (isRemote || nextProject === CUSTOM) return;
    const selected = projects.find((candidate) => candidate.name === nextProject);
    if (!selected) return;

    const requestGate = projectValidationGateRef.current;
    const token = requestGate.issue(
      requestSourceKey("new-worktree-local-project", selected.name, selected.path),
    );
    setValidatingProject(true);
    void dashboardBackend.projects.removeMissing({
      name: selected.name,
      path: selected.path,
    }).then((result) => {
      if (!requestGate.isCurrent(token)) return;
      setValidatingProject(false);
      if (!result.removed) return;
      setProjects(result.projects);
      setProject(CUSTOM);
      setError(`Removed "${selected.name}" because its directory no longer exists: ${selected.path}`);
    }).catch((reason) => {
      if (!requestGate.isCurrent(token)) return;
      setValidatingProject(false);
      setError(String(reason));
    });
  };

  const browse = async () => {
    markCatalogDraftDirty();
    try {
      const picked = await dashboardBackend.dialog.selectDirectory({
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

  const beginBusy = (): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    return true;
  };

  const endBusy = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const restoreOrphan = async (orphan: Orphan) => {
    if (!isWorktreeAgentSelectionAvailable(
      agentAvailabilityRef.current,
      selectedHost,
      aiCmd,
    )) {
      setError("Select an agent detected as available on the current host.");
      return;
    }
    if (!beginBusy()) return;
    try {
      const accepted = await onRestoreWorktree({
        path: orphan.path,
        name: orphan.name,
        aiCmd: aiCmd.trim() || "",
        ...(orphan.hostId ? { hostId: orphan.hostId } : {}),
      });
      if (!accepted) {
        endBusy();
        return;
      }
      saveLastAiCmd(aiCmd);
    } catch (err) {
      setError(String(err));
      endBusy();
    }
  };

  const deleteOrphan = async (orphan: Orphan) => {
    if (!beginBusy()) return;
    try {
      const accepted = await onDeleteWorktree(orphan);
      if (accepted) {
        setOrphans((prev) => prev.filter((item) => item.path !== orphan.path));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      endBusy();
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isWorktreeAgentSelectionAvailable(
      agentAvailabilityRef.current,
      selectedHost,
      aiCmd,
    )) {
      setError("Select an agent detected as available on the current host.");
      return;
    }
    if (!beginBusy()) return;
    try {
      const createArgs: CreateWorktreeInput = {
        aiCmd: aiCmd.trim(),
        name: name.trim() || null,
      };
      let preset: WorkspaceCreateWorktreeRequest["preset"];

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
          preset = { name: presetName, path };
          createArgs.project = presetName;
        } else {
          createArgs.path = path;
        }
      } else {
        const selected = projects.find((candidate) => candidate.name === project);
        if (!selected) throw new Error("project required");
        const result = await dashboardBackend.projects.removeMissing({
          name: selected.name,
          path: selected.path,
        });
        if (result.removed) {
          setProjects(result.projects);
          setProject(CUSTOM);
          setError(`Removed "${selected.name}" because its directory no longer exists: ${selected.path}`);
          endBusy();
          return;
        }
        createArgs.project = project;
      }
      if (branch.trim()) {
        createArgs.branch = branch.trim();
      }

      const accepted = await onCreateWorktree({
        args: createArgs,
        ...(preset ? { preset } : {}),
      });
      if (!accepted) {
        endBusy();
        return;
      }
      saveLastAiCmd(aiCmd);
    } catch (err) {
      setError(String(err));
      endBusy();
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
        aria-busy={busy}
        aria-hidden={showRemotePicker ? true : undefined}
        inert={showRemotePicker}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
        onSubmit={submit}
      >
        <div className="modal__title" id={titleId}>new worktree</div>

        {orphans.length > 0 && (
          <div className="field">
            <span className="field__label">restore existing</span>
            <div className="orphan-list">
              {orphans.map((o) => (
                <div key={o.path} className="orphan-row">
                  <button
                    type="button"
                    className="btn btn--ghost orphan-item"
                    disabled={busy || agentLoading || !agentSelectionAvailable}
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
                    <X aria-hidden="true" size={13} strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {orphans.length > 0 && (
          <div className="modal__divider">or create new</div>
        )}

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
          <span className="field__label">project</span>
          <MenuSelect
            ariaLabel="Project"
            value={project}
            options={projectMenuOptions}
            onChange={changeProject}
            disabled={busy || validatingProject || (isRemote && projectCatalogLoading)}
          />
          {isRemote && !projectCatalogLoading && projects.length === 0 && !error && (
            <span className="field__hint" role="status">
              No projects found in ~/.tmux-worktree.json on {selectedHostLabel}. Use a custom path or add a projects entry on that host.
            </span>
          )}
        </label>

        {isCustom && (
          <>
            <label className="field">
              <span className="field__label">{isRemote ? "remote path" : "path"}</span>
              <div className="field__row">
                <input
                  className="field__input"
                  type="text"
                  value={customPath}
                  onChange={(e) => {
                    markCatalogDraftDirty();
                    setCustomPath(e.target.value);
                  }}
                  placeholder={isRemote ? "/path/to/repo/on/remote" : "/path/to/repo"}
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
                  onClick={() => {
                    if (isRemote) {
                      markCatalogDraftDirty();
                      setShowRemotePicker(true);
                    } else {
                      void browse();
                    }
                  }}
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
                onChange={(e) => {
                  markCatalogDraftDirty();
                  setSavePreset(e.target.checked);
                }}
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
                  onChange={(e) => {
                    markCatalogDraftDirty();
                    setCustomName(e.target.value);
                  }}
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
            ref={initialFocusRef}
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
          <span className="field__label">agent</span>
          <MenuSelect
            ariaLabel="Agent"
            value={aiCmd}
            options={agentMenuOptions}
            onChange={(command) => {
              preferredAgentRef.current = command;
              setAiCmd(command);
            }}
            disabled={busy || agentLoading || !!agentError || agentResults.length === 0}
          />
          {agentLoading ? (
            <span className="field__hint" role="status">
              Checking supported agents on {selectedHostLabel}…
            </span>
          ) : agentError ? (
            <span className="field__hint" role="alert">
              Could not detect agents on {selectedHostLabel}: {agentError}
            </span>
          ) : agentResults.length === 0 ? (
            <span className="field__hint" role="status">
              Install a supported agent on {selectedHostLabel} before creating or restoring a worktree.
            </span>
          ) : null}
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
              validatingProject ||
              agentLoading ||
              !agentSelectionAvailable ||
              (isCustom &&
                (!customPath.trim() ||
                  (!isRemote && savePreset && !customName.trim())))
            }
          >
            {busy ? "creating…" : isRemote ? "create on remote" : "create"}
          </button>
        </div>
      </form>
      {showRemotePicker && isRemote && (
        <RemoteDirectoryPicker
          hostId={selectedHost}
          initialPath={customPath}
          returnFocusRef={remoteBrowseButtonRef}
          onClose={() => setShowRemotePicker(false)}
          onSelect={(path) => {
            markCatalogDraftDirty();
            setCustomPath(path);
            if (!customName.trim()) {
              setCustomName(path.split("/").filter(Boolean).pop() ?? "");
            }
            setShowRemotePicker(false);
          }}
        />
      )}
    </div>
  );
}
