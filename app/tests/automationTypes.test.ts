import assert from "node:assert/strict";
import test from "node:test";
import {
  automationFromRecord,
  automationRunFromRecord,
  automationSaveInputFromDraft,
  automationStatusLabel,
  createAutomationDraft,
  formatAutomationRunSummary,
  shouldRunAutomationSchedule,
  triggerLabel,
  updateAutomationDraft,
  validateAutomationDraft,
  type Automation,
  type AutomationRecord,
  type AutomationRun,
  type AutomationRunRecord,
} from "../src/automationTypes.ts";

test("triggerLabel shows manual automations when no schedule is set", () => {
  assert.equal(triggerLabel({ schedule: "" }), "manual");
  assert.equal(triggerLabel({ schedule: "   " }), "manual");
});

test("triggerLabel includes a trimmed schedule", () => {
  assert.equal(triggerLabel({ schedule: "  0 9 * * 1-5 " }), "schedule · 0 9 * * 1-5");
});

test("automationStatusLabel maps active state to user-facing labels", () => {
  assert.equal(automationStatusLabel({ active: true }), "active");
  assert.equal(automationStatusLabel({ active: false }), "paused");
});

test("createAutomationDraft returns a valid draft for new automations", () => {
  const draft = createAutomationDraft();

  assert.deepEqual(draft, {
    name: "",
    instruction: "",
    aiCmd: "claude",
    project: "",
    path: "",
    schedule: "",
    allowOverlap: false,
    active: true,
  });
  assert.deepEqual(validateAutomationDraft(draft), {
    valid: false,
    errors: {
      name: "Name is required",
      instruction: "Instruction is required",
      target: "Choose a project or path",
    },
  });
});

test("createAutomationDraft copies an existing automation into editable fields", () => {
  const automation: Automation = {
    id: "auto-1",
    name: "Daily triage",
    instruction: "Summarize pending reviews",
    aiCmd: "codex --ask-for-approval never",
    project: "tmux-worktree",
    path: "",
    schedule: "0 10 * * 1-5",
    allowOverlap: true,
    active: false,
  };

  assert.deepEqual(createAutomationDraft(automation), {
    name: "Daily triage",
    instruction: "Summarize pending reviews",
    aiCmd: "codex --ask-for-approval never",
    project: "tmux-worktree",
    path: "",
    schedule: "0 10 * * 1-5",
    allowOverlap: true,
    active: false,
  });
});

test("updateAutomationDraft trims saved text and coerces boolean fields", () => {
  const draft = createAutomationDraft();
  const updated = updateAutomationDraft(draft, {
    name: "  Nightly check  ",
    instruction: "  Run tests  ",
    aiCmd: "  codex  ",
    project: "  tmux-worktree  ",
    allowOverlap: true,
  });

  assert.deepEqual(updated, {
    ...draft,
    name: "Nightly check",
    instruction: "Run tests",
    aiCmd: "codex",
    project: "tmux-worktree",
    allowOverlap: true,
  });
});

test("validateAutomationDraft accepts either a project or path target", () => {
  const base = updateAutomationDraft(createAutomationDraft(), {
    name: "Review",
    instruction: "Check failures",
  });

  assert.equal(validateAutomationDraft({ ...base, project: "app" }).valid, true);
  assert.equal(validateAutomationDraft({ ...base, path: "/tmp/app" }).valid, true);
  assert.deepEqual(validateAutomationDraft(base).errors, {
    target: "Choose a project or path",
  });
});

test("validateAutomationDraft rejects missing AI command", () => {
  const draft = updateAutomationDraft(createAutomationDraft(), {
    name: "Review",
    instruction: "Check failures",
    project: "app",
    aiCmd: " ",
  });

  assert.deepEqual(validateAutomationDraft(draft), {
    valid: false,
    errors: { aiCmd: "AI command is required" },
  });
});

test("formatAutomationRunSummary uses compact status and target labels", () => {
  const run: AutomationRun = {
    id: "run-1",
    automationId: "auto-1",
    status: "failed",
    startedAt: "2026-06-11T01:20:30Z",
    finishedAt: "2026-06-11T01:22:00Z",
    target: "tmux-worktree",
    message: "test failed",
  };

  assert.equal(
    formatAutomationRunSummary(run),
    "failed · tmux-worktree · 2026-06-11 01:20 · test failed",
  );
});

test("automationFromRecord maps backend contract into UI model", () => {
  const record: AutomationRecord = {
    id: "auto-1",
    name: "Daily triage",
    enabled: false,
    triggerType: "schedule",
    schedule: "0 9 * * 1-5",
    timezone: "Asia/Shanghai",
    project: "tmux-worktree",
    path: null,
    aiCmd: "codex",
    instruction: "Summarize issues",
    overlap: "skip",
    lastRunAt: "2026-06-11T01:20:30Z",
    lastStatus: "running",
    lastSession: "tmux-worktree-auto",
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-11T00:00:00Z",
  };

  assert.deepEqual(automationFromRecord(record), {
    id: "auto-1",
    name: "Daily triage",
    instruction: "Summarize issues",
    aiCmd: "codex",
    project: "tmux-worktree",
    path: "",
    schedule: "0 9 * * 1-5",
    allowOverlap: false,
    active: false,
    status: "running",
    lastRunAt: "2026-06-11T01:20:30Z",
    lastSession: "tmux-worktree-auto",
  });
});

test("automationSaveInputFromDraft maps UI fields into backend save input", () => {
  const draft = updateAutomationDraft(createAutomationDraft(), {
    name: "  Weekday check  ",
    instruction: "  Review tests  ",
    aiCmd: "  codex  ",
    project: "  tmux-worktree  ",
    schedule: "  0 9 * * 1-5  ",
    allowOverlap: false,
    active: true,
  });

  assert.deepEqual(automationSaveInputFromDraft(draft, "auto-1"), {
    id: "auto-1",
    name: "Weekday check",
    enabled: true,
    triggerType: "schedule",
    schedule: "0 9 * * 1-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    project: "tmux-worktree",
    path: null,
    aiCmd: "codex",
    instruction: "Review tests",
    overlap: "skip",
  });
});

test("automationRunFromRecord maps backend run errors into visible messages", () => {
  const run: AutomationRunRecord = {
    id: "run-1",
    automationId: "auto-1",
    status: "failed",
    startedAt: "2026-06-11T01:20:30Z",
    finishedAt: "2026-06-11T01:21:00Z",
    sessionName: null,
    error: "create failed",
  };

  assert.deepEqual(automationRunFromRecord(run, { id: "auto-1", project: "app", path: "" }), {
    id: "run-1",
    automationId: "auto-1",
    status: "failed",
    startedAt: "2026-06-11T01:20:30Z",
    finishedAt: "2026-06-11T01:21:00Z",
    sessionName: null,
    target: "app",
    message: "create failed",
  });
});

test("shouldRunAutomationSchedule matches cron minutes and avoids duplicate minute", () => {
  const automation: Automation = {
    id: "auto-1",
    name: "Daily triage",
    instruction: "Run",
    aiCmd: "codex",
    project: "app",
    path: "",
    schedule: "20 9 * * 1-5",
    allowOverlap: false,
    active: true,
  };

  assert.equal(
    shouldRunAutomationSchedule(automation, new Date(2026, 5, 11, 9, 20, 30)),
    true,
  );
  assert.equal(
    shouldRunAutomationSchedule(
      { ...automation, lastRunAt: new Date(2026, 5, 11, 9, 20, 0).toISOString() },
      new Date(2026, 5, 11, 9, 20, 30),
    ),
    false,
  );
  assert.equal(
    shouldRunAutomationSchedule(automation, new Date(2026, 5, 11, 9, 21, 0)),
    false,
  );
  assert.equal(
    shouldRunAutomationSchedule({ ...automation, active: false }, new Date(2026, 5, 11, 9, 20, 0)),
    false,
  );
});
