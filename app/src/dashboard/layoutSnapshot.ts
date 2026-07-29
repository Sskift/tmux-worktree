import { DEFAULT_COLUMN_ORDER } from "./layout/schema";
import type {
  DashboardLayoutPreferences,
  DiffFile,
  EditingFile,
  SidebarView,
  WindowLayout,
} from "./layout/types";
import type { PinnedItem, Selection } from "./model/selection";

export type DashboardLayoutSnapshotInput = {
  automationSectionCollapsed: boolean;
  collapsedProjects: string[];
  diffFile: DiffFile | null;
  editingFile: EditingFile | null;
  inspectorOpen: boolean;
  inspectorWidth: number;
  pinnedItems: PinnedItem[];
  scratchCollapsed: boolean;
  scratchWidth: number;
  selection: Selection;
  sessionOrder: string[];
  worktreeGroupOrder: string[];
  terminalOrder: string[];
  sidebarOpen: boolean;
  sidebarView: SidebarView;
  sidebarWidth: number;
  windowLayout: WindowLayout | null;
};

export type DashboardLayoutSnapshotCut = {
  attempt: number;
  snapshot: DashboardLayoutPreferences;
};

export function buildDashboardLayoutSnapshot({
  automationSectionCollapsed,
  collapsedProjects,
  diffFile,
  editingFile,
  inspectorOpen,
  inspectorWidth,
  pinnedItems,
  scratchCollapsed,
  scratchWidth,
  selection,
  sessionOrder,
  worktreeGroupOrder,
  terminalOrder,
  sidebarOpen,
  sidebarView,
  sidebarWidth,
  windowLayout,
}: DashboardLayoutSnapshotInput): DashboardLayoutPreferences {
  return {
    left: sidebarWidth,
    sidebarWidth,
    inspectorWidth,
    sidebarOpen,
    inspectorOpen,
    sidebarView,
    sessionOrder: [...sessionOrder],
    worktreeGroupOrder: [...worktreeGroupOrder],
    terminalOrder: [...terminalOrder],
    collapsedProjects: [...collapsedProjects],
    pinnedItems: pinnedItems.map((item) => ({ ...item })),
    automationSectionCollapsed,
    columnOrder: [...DEFAULT_COLUMN_ORDER],
    scratchCollapsed,
    scratchWidth,
    fileBrowserOpen: sidebarView === "files",
    selection: selection ? { ...selection } : null,
    editingFile: editingFile ? { ...editingFile } : null,
    diffFile: diffFile ? { ...diffFile } : null,
    ...(windowLayout ? { window: { ...windowLayout } } : {}),
  };
}
