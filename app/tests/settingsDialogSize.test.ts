import assert from "node:assert/strict";
import test from "node:test";
import {
  clampSettingsDialogSize,
  settingsDialogViewportBounds,
} from "../src/dashboard/Settings/settingsDialogSize.ts";

test("settings dialog bounds preserve viewport padding on desktop and compact layouts", () => {
  assert.deepEqual(settingsDialogViewportBounds({ width: 1200, height: 900 }), {
    min: { width: 640, height: 460 },
    max: { width: 1152, height: 852 },
  });
  assert.deepEqual(settingsDialogViewportBounds({ width: 500, height: 400 }), {
    min: { width: 476, height: 376 },
    max: { width: 476, height: 376 },
  });
});

test("settings dialog resize clamps both pointer and keyboard dimensions", () => {
  assert.deepEqual(
    clampSettingsDialogSize({ width: 320, height: 280 }, { width: 1440, height: 900 }),
    { width: 640, height: 460 },
  );
  assert.deepEqual(
    clampSettingsDialogSize({ width: 2000, height: 1200 }, { width: 1440, height: 900 }),
    { width: 1392, height: 852 },
  );
  assert.deepEqual(
    clampSettingsDialogSize({ width: Number.NaN, height: 600 }, { width: 1440, height: 900 }),
    { width: 780, height: 600 },
  );
});
