import assert from "node:assert/strict";
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
