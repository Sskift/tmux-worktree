export interface SettingsDialogSize {
  width: number;
  height: number;
}

export interface SettingsDialogViewport {
  width: number;
  height: number;
}

export const DEFAULT_SETTINGS_DIALOG_SIZE: SettingsDialogSize = {
  width: 1060,
  height: 740,
};

const MIN_SETTINGS_DIALOG_SIZE: SettingsDialogSize = {
  width: 640,
  height: 460,
};

const DESKTOP_VIEWPORT_PADDING = 48;
const COMPACT_VIEWPORT_PADDING = 24;
const COMPACT_BREAKPOINT = 720;

function finiteDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function settingsDialogViewportBounds(
  viewport: SettingsDialogViewport,
): { min: SettingsDialogSize; max: SettingsDialogSize } {
  const viewportWidth = finiteDimension(viewport.width, DEFAULT_SETTINGS_DIALOG_SIZE.width);
  const viewportHeight = finiteDimension(viewport.height, DEFAULT_SETTINGS_DIALOG_SIZE.height);
  const padding = viewportWidth <= COMPACT_BREAKPOINT
    ? COMPACT_VIEWPORT_PADDING
    : DESKTOP_VIEWPORT_PADDING;
  const max = {
    width: Math.max(1, Math.round(viewportWidth - padding)),
    height: Math.max(1, Math.round(viewportHeight - padding)),
  };
  return {
    min: {
      width: Math.min(MIN_SETTINGS_DIALOG_SIZE.width, max.width),
      height: Math.min(
        viewportWidth <= COMPACT_BREAKPOINT ? 440 : MIN_SETTINGS_DIALOG_SIZE.height,
        max.height,
      ),
    },
    max,
  };
}

export function clampSettingsDialogSize(
  size: SettingsDialogSize,
  viewport: SettingsDialogViewport,
): SettingsDialogSize {
  const bounds = settingsDialogViewportBounds(viewport);
  const width = finiteDimension(size.width, DEFAULT_SETTINGS_DIALOG_SIZE.width);
  const height = finiteDimension(size.height, DEFAULT_SETTINGS_DIALOG_SIZE.height);
  return {
    width: Math.min(bounds.max.width, Math.max(bounds.min.width, Math.round(width))),
    height: Math.min(bounds.max.height, Math.max(bounds.min.height, Math.round(height))),
  };
}
