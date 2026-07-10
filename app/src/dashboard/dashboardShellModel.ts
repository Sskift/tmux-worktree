export type ResizablePanel = "sidebar" | "inspector";

export const DASHBOARD_WIDE_BREAKPOINT = 1440;
export const DASHBOARD_MIN_WORKSPACE_WIDTH = 640;

export const DASHBOARD_PANEL_LIMITS: Record<ResizablePanel, { min: number; max: number }> = {
  sidebar: { min: 240, max: 360 },
  inspector: { min: 360, max: 480 },
};

export function clampDashboardPanelWidth(panel: ResizablePanel, width: number): number {
  const limits = DASHBOARD_PANEL_LIMITS[panel];
  return Math.round(Math.max(limits.min, Math.min(limits.max, width)));
}

export function clampDashboardPanelWidthForViewport(
  panel: ResizablePanel,
  requestedWidth: number,
  viewportWidth: number,
  otherPanelWidth: number,
): number {
  const normalized = clampDashboardPanelWidth(panel, requestedWidth);
  if (viewportWidth < DASHBOARD_WIDE_BREAKPOINT) return normalized;

  const otherPanel: ResizablePanel = panel === "sidebar" ? "inspector" : "sidebar";
  const normalizedOther = clampDashboardPanelWidth(otherPanel, otherPanelWidth);
  const viewportMaximum = Math.max(
    DASHBOARD_PANEL_LIMITS[panel].min,
    viewportWidth - DASHBOARD_MIN_WORKSPACE_WIDTH - normalizedOther,
  );
  return Math.min(normalized, DASHBOARD_PANEL_LIMITS[panel].max, viewportMaximum);
}

export function normalizeDashboardPanelWidths(
  viewportWidth: number,
  sidebarWidth: number,
  inspectorWidth: number,
): { sidebarWidth: number; inspectorWidth: number } {
  let sidebar = clampDashboardPanelWidth("sidebar", sidebarWidth);
  let inspector = clampDashboardPanelWidth("inspector", inspectorWidth);
  if (viewportWidth < DASHBOARD_WIDE_BREAKPOINT) {
    return { sidebarWidth: sidebar, inspectorWidth: inspector };
  }

  let excess = sidebar + inspector - (viewportWidth - DASHBOARD_MIN_WORKSPACE_WIDTH);
  if (excess <= 0) return { sidebarWidth: sidebar, inspectorWidth: inspector };

  const inspectorReduction = Math.min(
    excess,
    inspector - DASHBOARD_PANEL_LIMITS.inspector.min,
  );
  inspector -= inspectorReduction;
  excess -= inspectorReduction;

  if (excess > 0) {
    sidebar -= Math.min(
      excess,
      sidebar - DASHBOARD_PANEL_LIMITS.sidebar.min,
    );
  }

  return { sidebarWidth: sidebar, inspectorWidth: inspector };
}

export function dashboardPanelWidthFromPointer(
  panel: ResizablePanel,
  startWidth: number,
  horizontalDelta: number,
): number {
  const signedDelta = panel === "sidebar" ? horizontalDelta : -horizontalDelta;
  return clampDashboardPanelWidth(panel, startWidth + signedDelta);
}

export function dashboardPanelWidthFromKey(
  panel: ResizablePanel,
  currentWidth: number,
  key: string,
  largeStep = false,
): number | null {
  const limits = DASHBOARD_PANEL_LIMITS[panel];
  if (key === "Home") return limits.min;
  if (key === "End") return limits.max;

  const step = largeStep ? 24 : 8;
  if (key === "ArrowLeft") {
    return clampDashboardPanelWidth(
      panel,
      currentWidth + (panel === "sidebar" ? -step : step),
    );
  }
  if (key === "ArrowRight") {
    return clampDashboardPanelWidth(
      panel,
      currentWidth + (panel === "sidebar" ? step : -step),
    );
  }
  return null;
}
