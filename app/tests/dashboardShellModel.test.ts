import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  clampDashboardPanelWidth,
  clampDashboardPanelWidthForViewport,
  dashboardPanelWidthFromKey,
  dashboardPanelWidthFromPointer,
  normalizeDashboardPanelWidths,
  viewportTierForWidth,
} from "../src/dashboard/layout/panelGeometry.ts";

test("dashboard panels preserve the frozen default widths", () => {
  assert.equal(DEFAULT_SIDEBAR_WIDTH, 280);
  assert.equal(DEFAULT_INSPECTOR_WIDTH, 420);
});

test("viewport tiers preserve compact, drawer, and wide breakpoints", () => {
  assert.equal(viewportTierForWidth(959), "compact");
  assert.equal(viewportTierForWidth(960), "drawer");
  assert.equal(viewportTierForWidth(1439), "drawer");
  assert.equal(viewportTierForWidth(1440), "wide");
});

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

test("the docked sidebar preserves 640px from the native 960px minimum", () => {
  assert.equal(
    clampDashboardPanelWidthForViewport("sidebar", 360, 960, 480),
    320,
  );
  assert.equal(
    clampDashboardPanelWidthForViewport("sidebar", 360, 980, 480),
    340,
  );
  assert.equal(
    clampDashboardPanelWidthForViewport("sidebar", 360, 1000, 480),
    360,
  );
  assert.deepEqual(normalizeDashboardPanelWidths(960, 360, 480), {
    sidebarWidth: 320,
    inspectorWidth: 480,
  });
  assert.deepEqual(normalizeDashboardPanelWidths(959, 360, 480), {
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
