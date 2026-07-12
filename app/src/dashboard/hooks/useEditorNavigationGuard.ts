import { useLayoutEffect, useRef } from "react";
import type { AutomationSubmitOwner } from "../../automationDraftSync";
import { editingFileSourceKey } from "../../editorNavigationGuard";
import type { EditingFile } from "../layout/types";
import { basenameFromPath } from "../model/terminalIdentity";
import type { DashboardBackend } from "../../platform";
import {
  createEditorNavigationController,
  type EditorNavigationController,
} from "../navigation/editorNavigationController";

export type EditorNavigationGuard = Readonly<{
  requestEditorNavigation(
    navigate: () => void,
    options?: { ignoreAutomationDirty?: boolean },
  ): Promise<boolean>;
  handleEditorDirtyChange(dirty: boolean): void;
  handleAutomationDirtyChange(dirty: boolean): void;
  getAutomationSubmitOwner(): AutomationSubmitOwner;
}>;

type EditorNavigationGuardRegistration = {
  controller: EditorNavigationController;
  committedBackend: DashboardBackend | null;
  committedFileName: string;
};

const uncommittedBackendOwner = {};
const registrationByGuard = new WeakMap<
  EditorNavigationGuard,
  EditorNavigationGuardRegistration
>();

export function useEditorNavigationGuard(_options: {
  dashboardBackend: DashboardBackend;
  editingFile: EditingFile | null;
  automationDraftKey: string | null;
}): EditorNavigationGuard {
  const guardRef = useRef<EditorNavigationGuard | null>(null);
  if (!guardRef.current) {
    const registration: EditorNavigationGuardRegistration = {
      controller: createEditorNavigationController({
        backendOwner: uncommittedBackendOwner,
        editorKey: null,
        automationKey: null,
      }),
      committedBackend: null,
      committedFileName: "the open file",
    };
    const guard: EditorNavigationGuard = {
      requestEditorNavigation(navigate, options = {}) {
        const requestBackend = registration.committedBackend;
        const fileName = registration.committedFileName;
        if (!requestBackend) return Promise.resolve(false);
        return registration.controller.request({
          confirmEditorDiscard: () =>
            requestBackend.dialog.confirm({
              title: "Discard unsaved changes?",
              message: `Changes to ${fileName} have not been saved. Continue and discard them?`,
            }),
          confirmAutomationDiscard: () =>
            requestBackend.dialog.confirm({
              title: "Discard unsaved automation changes?",
              message: "This automation draft has not been saved. Continue and discard it?",
            }),
          navigate,
          ignoreAutomationDirty: options.ignoreAutomationDirty,
        });
      },
      handleEditorDirtyChange(dirty) {
        registration.controller.editorDirtyChanged(dirty);
      },
      handleAutomationDirtyChange(dirty) {
        registration.controller.automationDirtyChanged(dirty);
      },
      getAutomationSubmitOwner() {
        return registration.controller.automationSubmitOwner();
      },
    };
    guardRef.current = guard;
    registrationByGuard.set(guard, registration);
  }
  return guardRef.current;
}

export function useEditorNavigationGuardLifecyclePhase(
  guard: EditorNavigationGuard,
  {
    dashboardBackend,
    editingFile,
    automationDraftKey,
  }: {
    dashboardBackend: DashboardBackend;
    editingFile: EditingFile | null;
    automationDraftKey: string | null;
  },
): void {
  const editorKey = editingFileSourceKey(editingFile);
  const fileName = basenameFromPath(editingFile?.path) || "the open file";
  useLayoutEffect(() => {
    const registration = registrationByGuard.get(guard);
    if (!registration) {
      throw new Error("Unknown editor navigation guard");
    }
    registration.committedBackend = dashboardBackend;
    registration.committedFileName = fileName;
    registration.controller.syncContext({
      backendOwner: dashboardBackend,
      editorKey,
      automationKey: automationDraftKey,
    });
  }, [automationDraftKey, dashboardBackend, editorKey, fileName, guard]);

  useLayoutEffect(() => {
    const registration = registrationByGuard.get(guard);
    if (!registration) {
      throw new Error("Unknown editor navigation guard");
    }
    registration.controller.activate();
    return () => registration.controller.deactivate();
  }, [guard]);
}
