import assert from "node:assert/strict";
import test from "node:test";
import {
  clampDashboardPanelWidth,
  clampDashboardPanelWidthForViewport,
  dashboardPanelWidthFromKey,
  dashboardPanelWidthFromPointer,
  normalizeDashboardPanelWidths,
} from "../src/dashboard/dashboardShellModel.ts";

test("dashboard panel widths clamp to responsive workspace-safe limits", () => {
  assert.equal(clampDashboardPanelWidth("sidebar", 120), 240);
  assert.equal(clampDashboardPanelWidth("sidebar", 420), 360);
  assert.equal(clampDashboardPanelWidth("inspector", 120), 360);
  assert.equal(clampDashboardPanelWidth("inspector", 900), 480);
});

test("wide panel combinations always preserve a 640px workspace", () => {
  assert.equal(
    clampDashboardPanelWidthForViewport("sidebar", 360, 1440, 480),
    320,
  );
  assert.equal(
    clampDashboardPanelWidthForViewport("inspector", 480, 1440, 360),
    440,
  );
  assert.equal(
    clampDashboardPanelWidthForViewport("inspector", 480, 1600, 360),
    480,
  );
  assert.deepEqual(normalizeDashboardPanelWidths(1440, 360, 480), {
    sidebarWidth: 360,
    inspectorWidth: 440,
  });
  assert.deepEqual(normalizeDashboardPanelWidths(1100, 360, 480), {
    sidebarWidth: 360,
    inspectorWidth: 480,
  });
});

test("pointer resizing follows the physical edge for each panel", () => {
  assert.equal(dashboardPanelWidthFromPointer("sidebar", 280, 24), 304);
  assert.equal(dashboardPanelWidthFromPointer("inspector", 420, -24), 444);
  assert.equal(dashboardPanelWidthFromPointer("inspector", 420, 24), 396);
});

test("separator keyboard controls support arrows, large steps, and bounds", () => {
  assert.equal(dashboardPanelWidthFromKey("sidebar", 280, "ArrowRight"), 288);
  assert.equal(dashboardPanelWidthFromKey("sidebar", 280, "ArrowLeft", true), 256);
  assert.equal(dashboardPanelWidthFromKey("inspector", 420, "ArrowLeft"), 428);
  assert.equal(dashboardPanelWidthFromKey("inspector", 420, "ArrowRight"), 412);
  assert.equal(dashboardPanelWidthFromKey("sidebar", 280, "Home"), 240);
  assert.equal(dashboardPanelWidthFromKey("inspector", 420, "End"), 480);
  assert.equal(dashboardPanelWidthFromKey("sidebar", 280, "Enter"), null);
});
