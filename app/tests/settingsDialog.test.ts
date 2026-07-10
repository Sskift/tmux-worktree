import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_SECTION_IDS,
  isSettingsSectionId,
} from "../src/dashboard/Settings/settingsModel.ts";
import { getWrappedFocusIndex } from "../src/dashboard/Settings/focusTrap.ts";

test("settings exposes the complete planned section model", () => {
  assert.deepEqual(SETTINGS_SECTION_IDS, [
    "general",
    "appearance",
    "connections",
    "integrations",
    "agents",
    "history",
    "automation",
    "advanced",
  ]);
  assert.equal(isSettingsSectionId("connections"), true);
  assert.equal(isSettingsSectionId("unknown"), false);
});

test("focus trap only wraps at dialog boundaries", () => {
  assert.equal(getWrappedFocusIndex(-1, 3, 1), 0);
  assert.equal(getWrappedFocusIndex(-1, 3, -1), 2);
  assert.equal(getWrappedFocusIndex(0, 3, -1), 2);
  assert.equal(getWrappedFocusIndex(2, 3, 1), 0);
  assert.equal(getWrappedFocusIndex(1, 3, 1), null);
  assert.equal(getWrappedFocusIndex(1, 3, -1), null);
  assert.equal(getWrappedFocusIndex(0, 0, 1), null);
});

test("settings dialog declares modal, keyboard, and focus-return behavior", () => {
  const source = readFileSync(
    new URL("../src/dashboard/Settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /keepFocusInside\(event\.nativeEvent, dialogRef\.current\)/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /focusTarget\?\.isConnected/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tabpanel"/);
});

test("settings content is injectable without presenting pretend controls", () => {
  const source = readFileSync(
    new URL("../src/dashboard/Settings/SettingsDialog.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /content\?: SettingsContent/);
  assert.match(source, /content\?\.\[activeSection\] \?\? DEFAULT_CONTENT\[activeSection\]/);
  assert.doesNotMatch(source, /type="checkbox"/);
});
