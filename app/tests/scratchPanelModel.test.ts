import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SCRATCH_PANEL_WIDTH,
  SCRATCH_PANEL_LIMITS,
  clampScratchPanelWidth,
  scratchPanelWidthFromKey,
  scratchPanelWidthFromPointer,
} from "../src/dashboard/scratchPanelModel.ts";

test("scratch width clamps while preserving a usable main workspace", () => {
  assert.equal(clampScratchPanelWidth(10), SCRATCH_PANEL_LIMITS.min);
  assert.equal(clampScratchPanelWidth(10_000), SCRATCH_PANEL_LIMITS.max);
  assert.equal(
    clampScratchPanelWidth(DEFAULT_SCRATCH_PANEL_WIDTH, 500),
    211,
  );
});

test("dragging the left boundary follows its physical direction", () => {
  assert.equal(scratchPanelWidthFromPointer(380, -40, 1200), 420);
  assert.equal(scratchPanelWidthFromPointer(380, 40, 1200), 340);
});

test("scratch separator supports keyboard resizing and bounds", () => {
  assert.equal(scratchPanelWidthFromKey(380, "ArrowLeft", false), 404);
  assert.equal(scratchPanelWidthFromKey(380, "ArrowRight", true), 332);
  assert.equal(scratchPanelWidthFromKey(380, "Home", false), SCRATCH_PANEL_LIMITS.min);
  assert.equal(scratchPanelWidthFromKey(380, "End", false), SCRATCH_PANEL_LIMITS.max);
  assert.equal(scratchPanelWidthFromKey(380, "Enter", false), null);
});
