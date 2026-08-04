import type { AutomationDraft } from "./automationTypes";

const AUTOMATION_DRAFT_FIELDS: Array<keyof AutomationDraft> = [
  "name",
  "instruction",
  "aiCmd",
  "project",
  "path",
  "schedule",
  "allowOverlap",
  "active",
];

export function automationDraftFingerprint(draft: AutomationDraft): string {
  return JSON.stringify(AUTOMATION_DRAFT_FIELDS.map((field) => draft[field]));
}

export function sameAutomationDraft(
  left: AutomationDraft | null,
  right: AutomationDraft | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return AUTOMATION_DRAFT_FIELDS.every((field) => left[field] === right[field]);
}

export type AutomationSubmitOwner = Readonly<{
  contextKey: string | null;
  revision: number;
}>;

export function automationSubmitStillOwnsDraft(
  originating: AutomationSubmitOwner,
  current: AutomationSubmitOwner,
): boolean {
  return originating.contextKey === current.contextKey &&
    originating.revision === current.revision;
}

export type AutomationDirtySignalState = Readonly<{
  dirty: boolean;
  revision: number;
}>;

/** Every edit advances ownership, even after the form is already dirty. */
export function recordAutomationDirtySignal(
  current: AutomationDirtySignalState,
  dirty: boolean,
): AutomationDirtySignalState {
  if (!dirty && !current.dirty) return current;
  return {
    dirty,
    revision: current.revision + 1,
  };
}

export function automationSelectionIsCurrent(
  currentId: string | null,
  nextId: string,
  editorOpen: boolean,
  expandedViewOpen: boolean,
): boolean {
  return currentId === nextId && !editorOpen && !expandedViewOpen;
}

export type AutomationDraftSyncDecision = {
  currentSelectionId: string | null;
  nextSelectionId: string;
  currentSourceDraft: AutomationDraft | null;
  nextSourceDraft: AutomationDraft;
  dirty: boolean;
  creating: boolean;
};

/**
 * Decide whether a server snapshot may replace the form draft.
 *
 * A logical selection change is explicit and always wins. For the same
 * automation, a snapshot only replaces a clean form when editable content
 * changed. Object remaps and run/status-only refreshes therefore remain inert,
 * while a dirty form is preserved until save, cancel, or another selection.
 */
export function shouldSyncAutomationDraft({
  currentSelectionId,
  nextSelectionId,
  currentSourceDraft,
  nextSourceDraft,
  dirty,
  creating,
}: AutomationDraftSyncDecision): boolean {
  if (currentSelectionId !== nextSelectionId) return true;
  if (creating || dirty) return false;
  return !sameAutomationDraft(currentSourceDraft, nextSourceDraft);
}
