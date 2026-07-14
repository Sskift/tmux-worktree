import assert from "node:assert/strict";
import test from "node:test";
import {
  THEME_MENU_MAX_HEIGHT,
  THEME_MENU_VIEWPORT_PADDING,
  calculateThemeMenuPosition,
} from "../src/themePickerPosition.ts";

test("theme menu opens below when the lower viewport has more room", () => {
  const position = calculateThemeMenuPosition(
    { top: 80, right: 760, bottom: 110, width: 140 },
    { width: 180, height: 720 },
    { width: 800, height: 600 },
  );

  assert.equal(position.side, "below");
  assert.equal(position.top, 116);
  assert.equal(position.maxHeight, THEME_MENU_MAX_HEIGHT);
  assert.equal(position.left, 580);
});

test("theme menu flips above and constrains its scroll height near the viewport bottom", () => {
  const position = calculateThemeMenuPosition(
    { top: 520, right: 760, bottom: 550, width: 140 },
    { width: 180, height: 720 },
    { width: 800, height: 600 },
  );

  assert.equal(position.side, "above");
  assert.equal(position.maxHeight, THEME_MENU_MAX_HEIGHT);
  assert.equal(position.top, 154);
});

test("theme menu stays inside narrow and short viewports", () => {
  const position = calculateThemeMenuPosition(
    { top: 44, right: 42, bottom: 74, width: 30 },
    { width: 220, height: 500 },
    { width: 150, height: 180 },
  );

  assert.equal(position.left, THEME_MENU_VIEWPORT_PADDING);
  assert.equal(position.width, 134);
  assert.ok(position.top >= THEME_MENU_VIEWPORT_PADDING);
  assert.ok(position.top + position.maxHeight <= 180 - THEME_MENU_VIEWPORT_PADDING);
});
