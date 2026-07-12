import type { DashboardBackend } from "../platform/dashboardBackend.ts";
import {
  createDashboardLayoutV2,
  migrateDashboardLayout,
  type DashboardLayoutV2,
} from "./layout/schema.ts";
import type { DashboardLayoutPreferences } from "./layout/types.ts";

type LayoutBackend = Pick<DashboardBackend, "persistence">;

export async function loadDashboardLayoutPreferences(
  backend: LayoutBackend,
): Promise<DashboardLayoutV2> {
  return migrateDashboardLayout(await backend.persistence.loadLayout());
}

export async function saveDashboardLayoutPreferences(
  backend: LayoutBackend,
  preferences: DashboardLayoutPreferences,
): Promise<void> {
  await backend.persistence.saveLayout(createDashboardLayoutV2(preferences));
}
