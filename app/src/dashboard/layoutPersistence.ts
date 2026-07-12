import type { DashboardBackend } from "../platform/dashboardBackend.ts";
import {
  createDashboardLayoutV2,
  decodeDashboardLayout,
  type DashboardLayoutDecodeOutcome,
  type DashboardLayoutExtensions,
} from "./layout/schema.ts";
import type { DashboardLayoutPreferences } from "./layout/types.ts";

type LayoutBackend = Pick<DashboardBackend, "persistence">;

const EMPTY_DASHBOARD_LAYOUT_EXTENSIONS: DashboardLayoutExtensions = Object.freeze({});

export async function loadDashboardLayoutPreferences(
  backend: LayoutBackend,
): Promise<DashboardLayoutDecodeOutcome> {
  return decodeDashboardLayout(await backend.persistence.loadLayout());
}

export async function saveDashboardLayoutPreferences(
  backend: LayoutBackend,
  preferences: DashboardLayoutPreferences,
  extensions: DashboardLayoutExtensions = EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
): Promise<void> {
  await backend.persistence.saveLayout(createDashboardLayoutV2(preferences, extensions));
}
