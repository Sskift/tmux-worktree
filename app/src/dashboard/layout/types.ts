import type { PinnedItem, Selection } from "../model/selection";

export type WindowLayout = {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
};

export type EditingFile = {
  path: string;
  hostId?: string | null;
  /** One-based location requested by search results or detected file links. */
  line?: number;
  column?: number;
};

export type DiffFile = {
  path: string;
  cwd: string;
  hostId?: string | null;
};

export type LayoutColumn = "file" | "main" | "scratch" | "editor";
export type SidebarView = "workspaces" | "files";
export type PersistedInspectorTab = "files" | "git" | "diff" | "feishu";
export type ResizablePanel = "sidebar" | "inspector";
export type ViewportTier = "compact" | "drawer" | "wide";

export type DashboardLayoutPreferences = {
  left?: number;
  right?: number;
  gitHeight?: number;
  sectionSplit?: number;
  automationHeight?: number;
  sessionOrder?: string[];
  worktreeGroupOrder?: string[];
  terminalOrder?: string[];
  collapsedProjects?: string[];
  pinnedItems?: PinnedItem[];
  automationSectionCollapsed?: boolean;
  columnOrder: LayoutColumn[];
  scratchCollapsed?: boolean;
  scratchWidth?: number;
  fileBrowserOpen?: boolean;
  fileTreeWidth?: number;
  editorWidth?: number;
  sidebarWidth?: number;
  inspectorWidth?: number;
  sidebarOpen?: boolean;
  sidebarView?: SidebarView;
  inspectorOpen?: boolean;
  inspectorTab?: PersistedInspectorTab;
  selection?: Selection;
  editingFile?: EditingFile | null;
  diffFile?: DiffFile | null;
  window?: WindowLayout;
};
