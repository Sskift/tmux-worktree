import type { DashboardBackend } from "../platform";
import type { DashboardWindow } from "../platform/types";
import type { LayoutSaveCoordinator } from "./layoutSaveCoordinator";
import type { DashboardLayoutSnapshotCut } from "./layoutSnapshot";
import {
  readWindowCapture,
  windowLayoutFromCapture,
} from "./windowCaptureCoordinator";

export type DashboardLayoutCloseGate = {
  attempt: number;
  backend: DashboardBackend | null;
  writable: boolean;
};

export type DashboardLayoutClosePersistenceOptions = {
  backend: DashboardBackend;
  coordinator: Pick<LayoutSaveCoordinator, "flush">;
  getGate(): DashboardLayoutCloseGate;
  getLatestSnapshotCut(): DashboardLayoutSnapshotCut | null;
  isActive(): boolean;
  target: DashboardWindow;
};

export async function flushDashboardLayoutOnClose(
  options: DashboardLayoutClosePersistenceOptions,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || !options.isActive()) return;
  const capture = await readWindowCapture(options.target, signal);
  if (
    signal.aborted ||
    capture.kind === "cancelled" ||
    !options.isActive()
  ) {
    return;
  }

  const gate = options.getGate();
  const cut = options.getLatestSnapshotCut();
  if (
    !gate.writable ||
    gate.backend !== options.backend ||
    cut === null ||
    cut.attempt !== gate.attempt ||
    signal.aborted ||
    !options.isActive()
  ) {
    return;
  }

  const finalSnapshot = capture.kind === "captured"
    ? {
        ...cut.snapshot,
        window: windowLayoutFromCapture(
          cut.snapshot.window ?? null,
          capture.result,
        ),
      }
    : cut.snapshot;
  if (signal.aborted || !options.isActive()) return;
  await options.coordinator.flush(gate.attempt, finalSnapshot, signal);
}
