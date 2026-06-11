import { useEffect, useMemo, useState } from "react";
import {
  automationScheduleLabel,
  automationStatusLabel,
  buildAutomationSchedule,
  createAutomationDraft,
  formatAutomationClockTime,
  formatAutomationRunSummary,
  parseAutomationClockTime,
  parseAutomationSchedule,
  triggerLabel,
  updateAutomationDraft,
  validateAutomationDraft,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
  type AutomationScheduleKind,
} from "./automationTypes";
import { loadLastAiCmd, saveLastAiCmd } from "./appPrefs";

type MaybePromise = unknown | Promise<unknown>;

export type AutomationProjectOption = {
  name: string;
  path: string;
  branch?: string | null;
};

export type AutomationPanelProps = {
  automations: Automation[];
  selectedId: string | null;
  runs: AutomationRun[];
  projectOptions?: AutomationProjectOption[];
  recentPath?: string | null;
  recentProject?: string | null;
  onSelect: (id: string) => MaybePromise;
  onCreate: (draft: AutomationDraft) => MaybePromise;
  onToggle: (id: string, active: boolean) => MaybePromise;
  onRun: (id: string) => MaybePromise;
  onDelete: (id: string) => MaybePromise;
  onSave: (id: string, draft: AutomationDraft) => MaybePromise;
  showList?: boolean;
};

const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  height: "100%",
  minHeight: 0,
};

const listStyle: React.CSSProperties = {
  flex: "0 0 auto",
  maxHeight: 220,
  minHeight: 80,
};

const detailStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minHeight: 0,
  overflowY: "auto",
  padding: "6px 10px 10px",
};

const rowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
};

const SCHEDULE_KIND_OPTIONS: Array<{ value: AutomationScheduleKind; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "every-5-minutes", label: "Every 5 minutes" },
  { value: "every-15-minutes", label: "Every 15 minutes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom cron" },
];

const OVERLAP_OPTIONS = [
  { value: "skip", label: "skip" },
  { value: "queue", label: "queue" },
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span style={{ color: "#ff8272", fontSize: 11 }}>{message}</span>;
}

function normalizeRecentPath(path?: string | null): string {
  return path?.trim() ?? "";
}

function pathMatchesProject(path: string, projectPath: string): boolean {
  const normalizedPath = path.replace(/\/+$/, "");
  const normalizedProjectPath = projectPath.replace(/\/+$/, "");
  return normalizedPath === normalizedProjectPath || normalizedPath.startsWith(`${normalizedProjectPath}/`);
}

function recentProjectName(
  recentPath: string,
  recentProject: string | null | undefined,
  projectOptions: AutomationProjectOption[],
): string {
  const project = recentProject?.trim();
  if (project && projectOptions.some((option) => option.name === project)) return project;
  if (!recentPath) return "";
  return (
    projectOptions.find((option) => option.path.trim() && pathMatchesProject(recentPath, option.path))
      ?.name ?? ""
  );
}

function createNewAutomationDraft(
  recentPath: string | null | undefined,
  recentProject: string | null | undefined,
  projectOptions: AutomationProjectOption[],
): AutomationDraft {
  const path = normalizeRecentPath(recentPath);
  const project = recentProjectName(path, recentProject, projectOptions);
  return {
    ...createAutomationDraft(),
    aiCmd: loadLastAiCmd(),
    ...(project ? { project } : path ? { path } : {}),
  };
}

export function AutomationPanel({
  automations,
  selectedId,
  runs,
  projectOptions = [],
  recentPath = null,
  recentProject = null,
  onSelect,
  onCreate,
  onToggle,
  onRun,
  onDelete,
  onSave,
  showList = true,
}: AutomationPanelProps) {
  const selected = useMemo(
    () => automations.find((automation) => automation.id === selectedId) ?? null,
    [automations, selectedId],
  );
  const [creating, setCreating] = useState(selectedId === null || automations.length === 0);
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    selected ? createAutomationDraft(selected) : createNewAutomationDraft(recentPath, recentProject, projectOptions),
  );
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const isCreating = creating || !selected;
  const recentPathValue = normalizeRecentPath(recentPath);
  const recentProjectValue = recentProjectName(recentPathValue, recentProject, projectOptions);

  useEffect(() => {
    if (selected) {
      setCreating(false);
      setSubmitAttempted(false);
      setFormError(null);
      setDraft(createAutomationDraft(selected));
    } else if (selectedId === null) {
      setCreating(true);
      setSubmitAttempted(false);
      setFormError(null);
      setDraft(createNewAutomationDraft(recentPath, recentProject, projectOptions));
    }
  }, [selected, selectedId]);

  useEffect(() => {
    if (automations.length === 0) {
      setCreating(true);
      setDraft((current) => {
        if (
          current.name.trim() ||
          current.instruction.trim() ||
          current.project.trim() ||
          current.path.trim()
        ) {
          return current;
        }
        return createNewAutomationDraft(recentPath, recentProject, projectOptions);
      });
    }
  }, [automations.length, recentPath, recentProject, projectOptions]);

  useEffect(() => {
    if (!isCreating || (!recentPathValue && !recentProjectValue)) return;
    setDraft((current) => {
      if (current.project.trim() || current.path.trim()) return current;
      return recentProjectValue
        ? { ...current, project: recentProjectValue }
        : { ...current, path: recentPathValue };
    });
  }, [isCreating, recentPathValue, recentProjectValue]);

  const normalizedDraft = updateAutomationDraft(draft, draft);
  const validation = validateAutomationDraft(normalizedDraft);
  const parsedSchedule = useMemo(() => parseAutomationSchedule(draft.schedule), [draft.schedule]);
  const scheduleTime = formatAutomationClockTime(parsedSchedule.hour, parsedSchedule.minute);
  const visibleRuns = selected
    ? runs.filter((run) => run.automationId === selected.id).slice(0, 6)
    : [];
  const projectSelectOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: AutomationProjectOption[] = [];
    const currentProject = draft.project.trim();
    if (
      currentProject &&
      !projectOptions.some((option) => option.name === currentProject)
    ) {
      seen.add(currentProject);
      options.push({ name: currentProject, path: "" });
    }
    for (const option of projectOptions) {
      const name = option.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      options.push({ name, path: option.path, branch: option.branch });
    }
    return options;
  }, [draft.project, projectOptions]);
  const selectedProjectPath =
    projectOptions.find((option) => option.name === draft.project)?.path.trim() ?? "";

  const setDraftField = <Key extends keyof AutomationDraft>(
    key: Key,
    value: AutomationDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const setSchedule = (schedule: string) => {
    setDraftField("schedule", schedule);
  };

  const handleScheduleKindChange = (kind: AutomationScheduleKind) => {
    setSchedule(
      buildAutomationSchedule(kind, parsedSchedule.hour, parsedSchedule.minute, parsedSchedule.custom),
    );
  };

  const handleScheduleTimeChange = (value: string) => {
    const parsedTime = parseAutomationClockTime(value);
    if (!parsedTime) return;
    setSchedule(
      buildAutomationSchedule(
        parsedSchedule.kind,
        parsedTime.hour,
        parsedTime.minute,
        parsedSchedule.custom,
      ),
    );
  };

  const handleProjectChange = (value: string) => {
    setDraft((current) => ({
      ...current,
      project: value,
      path: value ? "" : current.path,
    }));
  };

  const handlePathChange = (value: string) => {
    setDraft((current) => ({
      ...current,
      project: value.trim() ? "" : current.project,
      path: value,
    }));
  };

  const handleUseRecentPath = () => {
    if (!recentPathValue) return;
    setDraft((current) => ({
      ...current,
      project: "",
      path: recentPathValue,
    }));
  };

  const handleSelect = async (automation: Automation) => {
    setCreating(false);
    setSubmitAttempted(false);
    setFormError(null);
    setDraft(createAutomationDraft(automation));
    await onSelect(automation.id);
  };

  const handleNew = () => {
    setCreating(true);
    setSubmitAttempted(false);
    setFormError(null);
    setDraft(createNewAutomationDraft(recentPath, recentProject, projectOptions));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    setFormError(null);
    if (!validation.valid) return;

    setSaving(true);
    try {
      if (isCreating) {
        await onCreate(normalizedDraft);
        setDraft(createNewAutomationDraft(recentPath, recentProject, projectOptions));
      } else if (selected) {
        await onSave(selected.id, normalizedDraft);
      }
      saveLastAiCmd(normalizedDraft.aiCmd);
      setCreating(false);
    } catch (error) {
      setFormError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (id: string, action: () => MaybePromise) => {
    setActionId(id);
    setFormError(null);
    try {
      await action();
    } catch (error) {
      setFormError(String(error));
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="automation-panel" style={panelStyle}>
      {showList && (
        <>
          <div className="section-label">
            <span className="section-label__text">automations</span>
            <span className="section-label__line" />
            <button type="button" className="btn btn--ghost" onClick={handleNew}>
              + automation
            </button>
          </div>

          <nav className="sidebar__sessions" style={listStyle} aria-label="automations">
            {automations.length === 0 && <div className="empty empty--small">no automations</div>}
            {automations.map((automation) => {
              const selectedClass =
                !creating && automation.id === selected?.id ? " session--selected" : "";
              return (
                <div
                  key={automation.id}
                  className={`session${selectedClass}`}
                  onClick={() => {
                    void handleSelect(automation);
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void handleSelect(automation);
                    }
                  }}
                >
                  <span
                    className={`session__dot ${automation.active ? "session__dot--attached" : ""}`}
                    style={{ background: automation.active ? "#9ae6b4" : "var(--text-faint)" }}
                  />
                  <span className="session__name" title={automation.name}>
                    <span className="session__head">{automation.name || "(unnamed)"}</span>
                    <span className="session__tail"> · {triggerLabel(automation)}</span>
                  </span>
                  <span className="session__meta">{automationStatusLabel(automation)}</span>
                  <button
                    type="button"
                    className="session__kill"
                    title={`delete ${automation.name}`}
                    aria-label={`delete ${automation.name}`}
                    disabled={actionId === automation.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runAction(automation.id, () => onDelete(automation.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </nav>
        </>
      )}

      <form style={detailStyle} onSubmit={handleSubmit}>
        <label className="field">
          <span className="field__label">name</span>
          <input
            className="field__input"
            type="text"
            value={draft.name}
            onChange={(event) => setDraftField("name", event.target.value)}
            placeholder="daily review"
            autoComplete="off"
            spellCheck={false}
          />
          {submitAttempted && <FieldError message={validation.errors.name} />}
        </label>

        <label className="field">
          <span className="field__label">instruction</span>
          <textarea
            className="field__input"
            value={draft.instruction}
            onChange={(event) => setDraftField("instruction", event.target.value)}
            placeholder="what the agent should do"
            rows={4}
            style={{ height: 88, resize: "vertical", paddingTop: 8, lineHeight: 1.45 }}
            spellCheck={false}
          />
          {submitAttempted && <FieldError message={validation.errors.instruction} />}
        </label>

        <div style={rowStyle}>
          <label className="field">
            <span className="field__label">ai cmd</span>
            <input
              className="field__input"
              type="text"
              value={draft.aiCmd}
              onChange={(event) => setDraftField("aiCmd", event.target.value)}
              placeholder="claude"
              autoComplete="off"
              spellCheck={false}
            />
            {submitAttempted && <FieldError message={validation.errors.aiCmd} />}
          </label>

          <label className="field automation-schedule-field">
            <span className="field__label">schedule</span>
            <div className="automation-schedule-grid">
              <select
                className="field__input automation-select"
                value={parsedSchedule.kind}
                onChange={(event) => handleScheduleKindChange(event.target.value as AutomationScheduleKind)}
              >
                {SCHEDULE_KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {parsedSchedule.kind === "custom" ? (
                <input
                  className="field__input automation-input--mono"
                  type="text"
                  value={parsedSchedule.custom}
                  onChange={(event) => setSchedule(event.target.value)}
                  placeholder="0 9 * * *"
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : parsedSchedule.kind === "manual" ||
                parsedSchedule.kind === "hourly" ||
                parsedSchedule.kind === "every-5-minutes" ||
                parsedSchedule.kind === "every-15-minutes" ? null : (
                <input
                  className="field__input"
                  type="time"
                  value={scheduleTime}
                  onChange={(event) => handleScheduleTimeChange(event.target.value)}
                />
              )}
            </div>
            <span className="automation-field-hint">
              {automationScheduleLabel(draft.schedule)}
            </span>
          </label>
        </div>

        <div className="automation-target-grid">
          <label className="field">
            <span className="field__label">project</span>
            <select
              className="field__input automation-select"
              value={draft.project}
              onChange={(event) => handleProjectChange(event.target.value)}
            >
              <option value="">custom path</option>
              {projectSelectOptions.map((project) => (
                <option key={project.name} value={project.name}>
                  {project.path
                    ? `${project.name} - ${project.path}${project.branch ? ` @ ${project.branch}` : ""}`
                    : project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">path</span>
            <div className="field__row">
              <input
                className="field__input"
                type="text"
                value={draft.path}
                onChange={(event) => handlePathChange(event.target.value)}
                placeholder={selectedProjectPath || "/path/to/repo"}
                autoComplete="off"
                spellCheck={false}
              />
              {recentPathValue && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleUseRecentPath}
                  title={recentPathValue}
                >
                  use cwd
                </button>
              )}
            </div>
          </label>
        </div>
        {submitAttempted && <FieldError message={validation.errors.target} />}

        <div style={rowStyle}>
          <label className="field">
            <span className="field__label">overlap</span>
            <select
              className="field__input automation-select"
              value={draft.allowOverlap ? "queue" : "skip"}
              onChange={(event) => setDraftField("allowOverlap", event.target.value === "queue")}
            >
              {OVERLAP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="automation-field-hint">
              {draft.allowOverlap ? "queue overlapping runs" : "skip when a run is active"}
            </span>
          </label>

          <label className="field">
            <span className="field__label">status</span>
            <select
              className="field__input automation-select"
              value={draft.active ? "active" : "paused"}
              onChange={(event) => setDraftField("active", event.target.value === "active")}
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
            </select>
            <span className="automation-field-hint">{automationStatusLabel(draft)}</span>
          </label>
        </div>

        {formError && <div className="modal__error">{formError}</div>}

        <div className="modal__actions">
          {!isCreating && selected && (
            <>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={actionId === selected.id}
                onClick={() => {
                  void runAction(selected.id, () => onRun(selected.id));
                }}
              >
                Run now
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={actionId === selected.id}
                onClick={() => {
                  void runAction(selected.id, () => onToggle(selected.id, !selected.active));
                }}
              >
                {selected.active ? "pause" : "activate"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={actionId === selected.id}
                onClick={() => {
                  void runAction(selected.id, () => onDelete(selected.id));
                }}
              >
                delete
              </button>
            </>
          )}
          <button type="submit" className="btn btn--accent" disabled={saving || !validation.valid}>
            {isCreating ? "create" : "save"}
          </button>
        </div>

        <div className="section-label" style={{ padding: "4px 0 0" }}>
          <span className="section-label__text">runs</span>
          <span className="section-label__line" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {!selected && <div className="empty empty--small">select an automation</div>}
          {selected && visibleRuns.length === 0 && (
            <div className="empty empty--small">no runs</div>
          )}
          {visibleRuns.map((run) => (
            <div key={run.id} className="git__commit" title={run.id}>
              <div className="git__commit-row">
                <span className={`git__hash ${run.status === "running" ? "git__hash--merge" : ""}`}>
                  {run.status}
                </span>
                <span className="git__subject">{formatAutomationRunSummary(run)}</span>
              </div>
            </div>
          ))}
        </div>
      </form>
    </div>
  );
}
