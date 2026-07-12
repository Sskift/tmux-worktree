import type { EditingFile } from "./dashboard/layout/types";
import type { LatestRequestGate } from "./latestRequestGate";
import { requestSourceKey } from "./latestRequestGate";

export type EditorDirtySnapshot = Readonly<{
  fileKey: string | null;
  dirty: boolean;
  revision: number;
}>;

export function editingFileSourceKey(file: EditingFile | null): string | null {
  return file ? requestSourceKey(file.hostId ?? null, file.path) : null;
}

type GuardedEditorNavigationOptions = {
  gate: LatestRequestGate;
  snapshot: EditorDirtySnapshot;
  getCurrentSnapshot: () => EditorDirtySnapshot;
  confirmDiscard: () => Promise<boolean>;
  navigate: () => void;
};

export type DirtyNavigationSurface = {
  key: string | null;
  dirty: boolean;
  revision: number;
  getCurrent: () => Pick<DirtyNavigationSurface, "key" | "dirty" | "revision">;
  confirmDiscard: () => Promise<boolean>;
};

type GuardedWorkspaceNavigationOptions = {
  gate: LatestRequestGate;
  surfaces: DirtyNavigationSurface[];
  navigate: () => void;
};

export async function runGuardedWorkspaceNavigation({
  gate,
  surfaces,
  navigate,
}: GuardedWorkspaceNavigationOptions): Promise<boolean> {
  const request = gate.issue(surfaces.map((surface) => surface.key ?? "clean").join("|"));
  for (const surface of surfaces) {
    if (surface.key && surface.dirty && !(await surface.confirmDiscard())) {
      return false;
    }
    const current = surface.getCurrent();
    if (
      !gate.isCurrent(request) ||
      current.key !== surface.key ||
      current.revision !== surface.revision
    ) {
      return false;
    }
  }

  if (surfaces.some((surface) => {
    const current = surface.getCurrent();
    return current.key !== surface.key || current.revision !== surface.revision;
  })) {
    return false;
  }

  navigate();
  return true;
}

/**
 * Runs an editor-destructive navigation only when it is still the newest
 * intent and still targets the document/revision that requested confirmation.
 */
export async function runGuardedEditorNavigation({
  gate,
  snapshot,
  getCurrentSnapshot,
  confirmDiscard,
  navigate,
}: GuardedEditorNavigationOptions): Promise<boolean> {
  return runGuardedWorkspaceNavigation({
    gate,
    surfaces: [{
      key: snapshot.fileKey,
      dirty: snapshot.dirty,
      revision: snapshot.revision,
      getCurrent: () => {
        const current = getCurrentSnapshot();
        return {
          key: current.fileKey,
          dirty: current.dirty,
          revision: current.revision,
        };
      },
      confirmDiscard,
    }],
    navigate,
  });
}
