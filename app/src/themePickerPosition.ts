export const THEME_MENU_GAP = 6;
export const THEME_MENU_VIEWPORT_PADDING = 8;
export const THEME_MENU_MAX_HEIGHT = 360;
export const THEME_MENU_MIN_WIDTH = 160;

export type ThemeMenuSide = "above" | "below";

export type ThemeMenuAnchor = {
  top: number;
  right: number;
  bottom: number;
  width: number;
};

export type ThemeMenuSize = {
  width: number;
  height: number;
};

export type ThemeMenuViewport = {
  width: number;
  height: number;
};

export type ThemeMenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  side: ThemeMenuSide;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function calculateThemeMenuPosition(
  anchor: ThemeMenuAnchor,
  menu: ThemeMenuSize,
  viewport: ThemeMenuViewport,
): ThemeMenuPosition {
  const availableWidth = Math.max(
    0,
    viewport.width - THEME_MENU_VIEWPORT_PADDING * 2,
  );
  const width = Math.min(
    availableWidth,
    Math.max(THEME_MENU_MIN_WIDTH, anchor.width, menu.width),
  );
  const desiredHeight = Math.min(
    THEME_MENU_MAX_HEIGHT,
    Math.max(0, menu.height),
  );
  const spaceAbove = Math.max(
    0,
    anchor.top - THEME_MENU_GAP - THEME_MENU_VIEWPORT_PADDING,
  );
  const spaceBelow = Math.max(
    0,
    viewport.height - THEME_MENU_VIEWPORT_PADDING - anchor.bottom - THEME_MENU_GAP,
  );
  const side: ThemeMenuSide =
    spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? "below" : "above";
  const maxHeight = Math.min(
    THEME_MENU_MAX_HEIGHT,
    side === "below" ? spaceBelow : spaceAbove,
  );
  const renderedHeight = Math.min(Math.max(0, menu.height), maxHeight);
  const top = side === "below"
    ? anchor.bottom + THEME_MENU_GAP
    : anchor.top - THEME_MENU_GAP - renderedHeight;
  const maximumLeft = Math.max(
    THEME_MENU_VIEWPORT_PADDING,
    viewport.width - THEME_MENU_VIEWPORT_PADDING - width,
  );
  const left = clamp(
    anchor.right - width,
    THEME_MENU_VIEWPORT_PADDING,
    maximumLeft,
  );

  return {
    top: Math.max(THEME_MENU_VIEWPORT_PADDING, top),
    left,
    width,
    maxHeight,
    side,
  };
}
