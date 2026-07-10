import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  automationSelectionIsCurrent,
  automationSubmitStillOwnsDraft,
  recordAutomationDirtySignal,
  automationDraftFingerprint,
  sameAutomationDraft,
  shouldSyncAutomationDraft,
} from "../src/automationDraftSync.ts";
import { createAutomationDraft, type Automation } from "../src/automationTypes.ts";

const automation: Automation = {
  id: "daily-review",
  name: "Daily review",
  instruction: "Review the workspace",
  aiCmd: "claude",
  project: "dashboard",
  path: "",
  schedule: "0 9 * * 1-5",
  allowOverlap: false,
  active: true,
  status: "idle",
};

const sourceDraft = createAutomationDraft(automation);

function decide(
  overrides: Partial<Parameters<typeof shouldSyncAutomationDraft>[0]> = {},
): boolean {
  return shouldSyncAutomationDraft({
    currentSelectionId: automation.id,
    nextSelectionId: automation.id,
    currentSourceDraft: sourceDraft,
    nextSourceDraft: createAutomationDraft(automation),
    dirty: false,
    creating: false,
    ...overrides,
  });
}

test("remapped objects and run/status-only updates do not resync the draft", () => {
  const remappedDraft = createAutomationDraft({ ...automation });
  const runningDraft = createAutomationDraft({
    ...automation,
    status: "running",
    lastRunAt: "2026-07-10T08:00:00.000Z",
    lastSession: "daily-review-1",
  });

  assert.equal(sameAutomationDraft(sourceDraft, remappedDraft), true);
  assert.equal(automationDraftFingerprint(sourceDraft), automationDraftFingerprint(runningDraft));
  assert.equal(decide({ nextSourceDraft: runningDraft }), false);
});

test("clean forms follow editable backend changes", () => {
  assert.equal(
    decide({
      nextSourceDraft: { ...sourceDraft, schedule: "0 10 * * 1-5" },
    }),
    true,
  );
});

test("dirty forms ignore same-selection refreshes but explicit selection changes win", () => {
  const changedSource = { ...sourceDraft, active: false };

  assert.equal(decide({ nextSourceDraft: changedSource, dirty: true }), false);
  assert.equal(decide({ nextSourceDraft: changedSource, dirty: true, creating: true }), false);
  assert.equal(
    decide({
      currentSelectionId: automation.id,
      nextSelectionId: "weekly-review",
      nextSourceDraft: changedSource,
      dirty: true,
      creating: true,
    }),
    true,
  );
});

test("a late automation submit only owns the unchanged originating draft", () => {
  const origin = { contextKey: "automation:a", revision: 4 };
  assert.equal(automationSubmitStillOwnsDraft(origin, { ...origin }), true);
  assert.equal(
    automationSubmitStillOwnsDraft(origin, { contextKey: "automation:b", revision: 4 }),
    false,
  );
  assert.equal(
    automationSubmitStillOwnsDraft(origin, { contextKey: "automation:a", revision: 5 }),
    false,
  );
});

test("every automation edit advances ownership after the draft is already dirty", () => {
  const first = recordAutomationDirtySignal({ dirty: false, revision: 2 }, true);
  const second = recordAutomationDirtySignal(first, true);
  const clean = recordAutomationDirtySignal(second, false);

  assert.deepEqual(first, { dirty: true, revision: 3 });
  assert.deepEqual(second, { dirty: true, revision: 4 });
  assert.deepEqual(clean, { dirty: false, revision: 5 });
  assert.equal(automationSubmitStillOwnsDraft(
    { contextKey: "automation:a", revision: first.revision },
    { contextKey: "automation:a", revision: second.revision },
  ), false);
  assert.equal(recordAutomationDirtySignal(clean, false), clean);
});

test("reselecting the visible automation is a no-op that preserves its draft", () => {
  assert.equal(automationSelectionIsCurrent("a", "a", false, false), true);
  assert.equal(automationSelectionIsCurrent("a", "b", false, false), false);
  assert.equal(automationSelectionIsCurrent("a", "a", true, false), false);
  assert.equal(automationSelectionIsCurrent("a", "a", false, true), false);
});

test("AutomationPanel gates snapshot effects by editable content and exposes cancel", () => {
  const source = readFileSync(new URL("../src/AutomationPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldSyncAutomationDraft\(\{/);
  assert.match(source, /\[selected\?\.id, selectedDraftKey, selectedId\]/);
  assert.doesNotMatch(source, /\}, \[selected, selectedId\]\);/);
  assert.match(source, /const handleCancel = \(\) => \{/);
  assert.match(source, /if \(draftDirtyRef\.current\) return current;/);
  assert.match(source, /const accepted = await onSelect\(automation\.id\);/);
  assert.match(source, /if \(automation\.id === selected\?\.id && !creatingRef\.current\) return;/);
  assert.match(source, /if \(accepted === false\) return;/);
  assert.match(source, /const handleNew = async \(\) => \{\s*const accepted = await onNew\(\)/);
  assert.match(source, /<fieldset\s+disabled=\{saving\}/);
  assert.match(source, /const markDraftDirty[\s\S]*?onDirtyChange\?\.\(true\)/);
  assert.match(source, /const setDraftClean[\s\S]*?onDirtyChange\?\.\(false\)/);
  assert.match(source, />\s*cancel\s*<\/button>/);
});
