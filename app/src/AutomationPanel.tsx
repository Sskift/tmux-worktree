import { useEffect, useMemo, useState } from "react";
import {
  automationStatusLabel,
  createAutomationDraft,
  formatAutomationRunSummary,
  triggerLabel,
  updateAutomationDraft,
  validateAutomationDraft,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
} from "./automationTypes";

type MaybePromise = unknown | Promise<unknown>;

export type AutomationPanelProps = {
  automations: Automation[];
  selectedId: string | null;
  runs: AutomationRun[];
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

const hintStyle: React.CSSProperties = {
  color: "var(--text-faint)",
  fontSize: 11,
  lineHeight: 1.4,
};

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <span style={{ color: "#ff8272", fontSize: 11 }}>{message}</span>;
}

export function AutomationPanel({
  automations,
  selectedId,
  runs,
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
  const [creating, setCreating] = useState(automations.length === 0);
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    selected ? createAutomationDraft(selected) : createAutomationDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (creating) return;
    if (selected) setDraft(createAutomationDraft(selected));
  }, [creating, selected]);

  useEffect(() => {
    if (automations.length === 0) {
      setCreating(true);
      setDraft(createAutomationDraft());
    }
  }, [automations.length]);

  const normalizedDraft = updateAutomationDraft(draft, draft);
  const validation = validateAutomationDraft(normalizedDraft);
  const isCreating = creating || !selected;
  const visibleRuns = selected
    ? runs.filter((run) => run.automationId === selected.id).slice(0, 6)
    : [];

  const setDraftField = <Key extends keyof AutomationDraft>(
    key: Key,
    value: AutomationDraft[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
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
    setDraft(createAutomationDraft());
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
        setDraft(createAutomationDraft());
      } else if (selected) {
        await onSave(selected.id, normalizedDraft);
      }
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
      <div className="section-label">
        <span className="section-label__text">automations</span>
        <span className="section-label__line" />
        <button type="button" className="btn btn--ghost" onClick={handleNew}>
          + automation
        </button>
      </div>

      {showList && (
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
      )}

      <form style={detailStyle} onSubmit={handleSubmit}>
        <div className="section-label" style={{ padding: 0 }}>
          <span className="section-label__text">{isCreating ? "new automation" : "details"}</span>
          <span className="section-label__line" />
        </div>

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

          <label className="field">
            <span className="field__label">schedule</span>
            <input
              className="field__input"
              type="text"
              value={draft.schedule}
              onChange={(event) => setDraftField("schedule", event.target.value)}
              placeholder="manual or cron"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>

        <div style={rowStyle}>
          <label className="field">
            <span className="field__label">project</span>
            <input
              className="field__input"
              type="text"
              value={draft.project}
              onChange={(event) => setDraftField("project", event.target.value)}
              placeholder="preset name"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span className="field__label">path</span>
            <input
              className="field__input"
              type="text"
              value={draft.path}
              onChange={(event) => setDraftField("path", event.target.value)}
              placeholder="/path/to/repo"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        {submitAttempted && <FieldError message={validation.errors.target} />}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.allowOverlap}
              onChange={(event) => setDraftField("allowOverlap", event.target.checked)}
            />
            <span>allow overlapping runs</span>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) => setDraftField("active", event.target.checked)}
            />
            <span>{automationStatusLabel(draft)}</span>
          </label>
        </div>

        <div style={hintStyle}>
          {triggerLabel(draft)} · {draft.allowOverlap ? "overlap allowed" : "single run"}
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
