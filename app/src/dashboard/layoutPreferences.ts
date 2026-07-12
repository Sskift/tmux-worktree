export type { PinnedItem, Selection } from "./model/selection";
export type {
  DashboardLayoutPreferences,
  DiffFile,
  EditingFile,
  LayoutColumn,
  PersistedInspectorTab,
  SidebarView,
  WindowLayout,
} from "./layout/types";
export {
  DASHBOARD_LAYOUT_SCHEMA_VERSION,
  DEFAULT_COLUMN_ORDER,
  createDashboardLayoutV2,
  isDashboardLayoutV2,
  migrateDashboardLayout,
  normalizeColumnOrder,
} from "./layout/schema";
export type { DashboardLayoutV2 } from "./layout/schema";
