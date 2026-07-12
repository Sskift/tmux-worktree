import {
  recordAutomationDirtySignal,
  type AutomationSubmitOwner,
} from "../../automationDraftSync";
import {
  runGuardedWorkspaceNavigation,
  type EditorDirtySnapshot,
} from "../../editorNavigationGuard";
import { createLatestRequestGate } from "../../latestRequestGate";

export type EditorNavigationControllerContext = Readonly<{
  backendOwner: object;
  editorKey: string | null;
  automationKey: string | null;
}>;

export type EditorNavigationRequest = Readonly<{
  confirmEditorDiscard: () => Promise<boolean>;
  confirmAutomationDiscard: () => Promise<boolean>;
  navigate: () => void;
  ignoreAutomationDirty?: boolean;
}>;

export type EditorNavigationController = Readonly<{
  syncContext(context: EditorNavigationControllerContext): void;
  activate(): void;
  deactivate(): void;
  editorDirtyChanged(dirty: boolean): void;
  automationDirtyChanged(dirty: boolean): void;
  automationSubmitOwner(): AutomationSubmitOwner;
  request(options: EditorNavigationRequest): Promise<boolean>;
}>;

function rolloverDirtySnapshot(
  current: EditorDirtySnapshot,
  key: string | null,
): EditorDirtySnapshot {
  if (current.fileKey === key) return current;
  return {
    fileKey: key,
    dirty: false,
    revision: current.revision + 1,
  };
}

function clearDirtySnapshot(current: EditorDirtySnapshot): EditorDirtySnapshot {
  return {
    ...current,
    dirty: false,
    revision: current.revision + 1,
  };
}

export function createEditorNavigationController(
  initialContext: EditorNavigationControllerContext,
): EditorNavigationController {
  const gate = createLatestRequestGate();
  let active = false;
  let backendOwner = initialContext.backendOwner;
  let editorSnapshot: EditorDirtySnapshot = {
    fileKey: initialContext.editorKey,
    dirty: false,
    revision: 0,
  };
  let automationSnapshot: EditorDirtySnapshot = {
    fileKey: initialContext.automationKey,
    dirty: false,
    revision: 0,
  };

  return {
    syncContext(context) {
      if (backendOwner !== context.backendOwner) {
        backendOwner = context.backendOwner;
        gate.invalidate();
      }
      editorSnapshot = rolloverDirtySnapshot(editorSnapshot, context.editorKey);
      automationSnapshot = rolloverDirtySnapshot(
        automationSnapshot,
        context.automationKey,
      );
    },

    activate() {
      active = true;
    },

    deactivate() {
      active = false;
      gate.invalidate();
    },

    editorDirtyChanged(dirty) {
      if (editorSnapshot.dirty === dirty) return;
      editorSnapshot = {
        ...editorSnapshot,
        dirty,
        revision: editorSnapshot.revision + 1,
      };
    },

    automationDirtyChanged(dirty) {
      const next = recordAutomationDirtySignal(automationSnapshot, dirty);
      if (next === automationSnapshot) return;
      automationSnapshot = {
        ...automationSnapshot,
        ...next,
      };
    },

    automationSubmitOwner() {
      return {
        contextKey: automationSnapshot.fileKey,
        revision: automationSnapshot.revision,
      };
    },

    request({
      confirmEditorDiscard,
      confirmAutomationDiscard,
      navigate,
      ignoreAutomationDirty = false,
    }) {
      if (!active) return Promise.resolve(false);
      const requestedEditor = editorSnapshot;
      const requestedAutomation = automationSnapshot;
      return runGuardedWorkspaceNavigation({
        gate,
        surfaces: [
          {
            key: requestedEditor.fileKey,
            dirty: requestedEditor.dirty,
            revision: requestedEditor.revision,
            getCurrent: () => ({
              key: editorSnapshot.fileKey,
              dirty: editorSnapshot.dirty,
              revision: editorSnapshot.revision,
            }),
            confirmDiscard: confirmEditorDiscard,
          },
          {
            key: requestedAutomation.fileKey,
            dirty: ignoreAutomationDirty ? false : requestedAutomation.dirty,
            revision: requestedAutomation.revision,
            getCurrent: () => ({
              key: automationSnapshot.fileKey,
              dirty: automationSnapshot.dirty,
              revision: automationSnapshot.revision,
            }),
            confirmDiscard: confirmAutomationDiscard,
          },
        ],
        navigate: () => {
          editorSnapshot = clearDirtySnapshot(editorSnapshot);
          automationSnapshot = clearDirtySnapshot(automationSnapshot);
          navigate();
        },
      });
    },
  };
}
