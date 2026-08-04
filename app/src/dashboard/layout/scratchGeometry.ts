export const SCRATCH_PANEL_LIMITS = {
  min: 260,
  max: 560,
  mainMin: 280,
  handle: 9,
  step: 24,
} as const;

export const DEFAULT_SCRATCH_PANEL_WIDTH = 380;

function availableScratchWidth(containerWidth?: number): number {
  if (!containerWidth || !Number.isFinite(containerWidth)) {
    return SCRATCH_PANEL_LIMITS.max;
  }
  return Math.max(
    180,
    Math.min(
      SCRATCH_PANEL_LIMITS.max,
      containerWidth - SCRATCH_PANEL_LIMITS.mainMin - SCRATCH_PANEL_LIMITS.handle,
    ),
  );
}

export function clampScratchPanelWidth(width: number, containerWidth?: number): number {
  const max = availableScratchWidth(containerWidth);
  const min = Math.min(SCRATCH_PANEL_LIMITS.min, max);
  if (!Number.isFinite(width)) return Math.min(DEFAULT_SCRATCH_PANEL_WIDTH, max);
  return Math.round(Math.max(min, Math.min(max, width)));
}

export function scratchPanelWidthFromPointer(
  currentWidth: number,
  horizontalDelta: number,
  containerWidth?: number,
): number {
  return clampScratchPanelWidth(currentWidth - horizontalDelta, containerWidth);
}

export function scratchPanelWidthFromKey(
  currentWidth: number,
  key: string,
  shiftKey: boolean,
  containerWidth?: number,
): number | null {
  const step = SCRATCH_PANEL_LIMITS.step * (shiftKey ? 2 : 1);
  const max = availableScratchWidth(containerWidth);
  switch (key) {
    case "ArrowLeft":
      return clampScratchPanelWidth(currentWidth + step, containerWidth);
    case "ArrowRight":
      return clampScratchPanelWidth(currentWidth - step, containerWidth);
    case "Home":
      return clampScratchPanelWidth(SCRATCH_PANEL_LIMITS.min, containerWidth);
    case "End":
      return clampScratchPanelWidth(max, containerWidth);
    default:
      return null;
  }
}

export function scratchPanelMaximumWidth(containerWidth?: number): number {
  return availableScratchWidth(containerWidth);
}
