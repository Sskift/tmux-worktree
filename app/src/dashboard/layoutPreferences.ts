export const DASHBOARD_LAYOUT_SCHEMA_VERSION = 2 as const;

export type Selection =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string }
  | { kind: "automation"; id: string }
  | null;

export type PinnedItem =
  | { kind: "session"; name: string }
  | { kind: "terminal"; id: string };

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

export const DEFAULT_COLUMN_ORDER: LayoutColumn[] = [
  "file",
  "main",
  "scratch",
  "editor",
];

export type DashboardLayoutPreferences = {
  left?: number;
  right?: number;
  gitHeight?: number;
  sectionSplit?: number;
  automationHeight?: number;
  sessionOrder?: string[];
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

/**
 * Version 2 deliberately keeps the legacy fields at the top level. The Rust
 * startup path reads `window` before the renderer starts, so a nested envelope
 * would break native window restoration. `schemaVersion` makes the compatible
 * envelope explicit while Phase 2 evolves the visual layout.
 */
export type DashboardLayoutV2 = DashboardLayoutPreferences & {
  schemaVersion: typeof DASHBOARD_LAYOUT_SCHEMA_VERSION;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidHostId(record: Record<string, unknown>): boolean {
  return (
    record.hostId === undefined ||
    record.hostId === null ||
    typeof record.hostId === "string"
  );
}

function isSelection(value: unknown): value is Selection {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    (value.kind === "session" && typeof value.name === "string") ||
    (value.kind === "terminal" && typeof value.id === "string") ||
    (value.kind === "automation" && typeof value.id === "string")
  );
}

function isPinnedItem(value: unknown): value is PinnedItem {
  if (!isRecord(value)) return false;
  return (
    (value.kind === "session" && typeof value.name === "string" && value.name.length > 0) ||
    (value.kind === "terminal" && typeof value.id === "string" && value.id.length > 0)
  );
}

function isPinnedItems(value: unknown): value is PinnedItem[] {
  return Array.isArray(value) && value.every(isPinnedItem);
}

function isEditingFile(value: unknown): value is EditingFile {
  if (!isRecord(value) || typeof value.path !== "string" || !hasValidHostId(value)) {
    return false;
  }
  const validLocation = (field: unknown) =>
    field === undefined ||
    (typeof field === "number" && Number.isInteger(field) && field > 0);
  return validLocation(value.line) && validLocation(value.column);
}

function isDiffFile(value: unknown): value is DiffFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.cwd === "string" &&
    hasValidHostId(value)
  );
}

function isWindowLayout(value: unknown): value is WindowLayout {
  return (
    isRecord(value) &&
    isPositiveFiniteNumber(value.width) &&
    isPositiveFiniteNumber(value.height) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    typeof value.maximized === "boolean"
  );
}

function isLayoutColumn(value: unknown): value is LayoutColumn {
  return value === "file" || value === "main" || value === "scratch" || value === "editor";
}

function isInspectorTab(value: unknown): value is PersistedInspectorTab {
  return (
    value === "files" ||
    value === "git" ||
    value === "diff" ||
    value === "feishu"
  );
}

function isSidebarView(value: unknown): value is SidebarView {
  return value === "workspaces" || value === "files";
}

export function normalizeColumnOrder(value: unknown): LayoutColumn[] {
  const seen = new Set<LayoutColumn>();
  const restored = Array.isArray(value)
    ? value.filter((item): item is LayoutColumn => {
        if (!isLayoutColumn(item) || seen.has(item)) return false;
        seen.add(item);
        return true;
      })
    : [];
  return [...restored, ...DEFAULT_COLUMN_ORDER.filter((column) => !seen.has(column))];
}

function isNormalizedColumnOrder(value: unknown): value is LayoutColumn[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_COLUMN_ORDER.length) return false;
  const normalized = normalizeColumnOrder(value);
  return normalized.every((column, index) => column === value[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.every((item) => item.length > 0);
}

function optionalField(
  record: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
): boolean {
  return !hasOwn(record, key) || predicate(record[key]);
}

export function isDashboardLayoutV2(value: unknown): value is DashboardLayoutV2 {
  if (!isRecord(value) || value.schemaVersion !== DASHBOARD_LAYOUT_SCHEMA_VERSION) return false;
  return (
    isNormalizedColumnOrder(value.columnOrder) &&
    optionalField(value, "left", isPositiveFiniteNumber) &&
    optionalField(value, "right", isPositiveFiniteNumber) &&
    optionalField(value, "gitHeight", isPositiveFiniteNumber) &&
    optionalField(value, "sectionSplit", isPositiveFiniteNumber) &&
    optionalField(value, "automationHeight", isPositiveFiniteNumber) &&
    optionalField(value, "sessionOrder", isStringArray) &&
    optionalField(value, "collapsedProjects", isNonEmptyStringArray) &&
    optionalField(value, "pinnedItems", isPinnedItems) &&
    optionalField(value, "automationSectionCollapsed", (field) => typeof field === "boolean") &&
    optionalField(value, "scratchCollapsed", (field) => typeof field === "boolean") &&
    optionalField(value, "scratchWidth", isPositiveFiniteNumber) &&
    optionalField(value, "fileBrowserOpen", (field) => typeof field === "boolean") &&
    optionalField(value, "fileTreeWidth", isPositiveFiniteNumber) &&
    optionalField(value, "editorWidth", isPositiveFiniteNumber) &&
    optionalField(value, "sidebarWidth", isPositiveFiniteNumber) &&
    optionalField(value, "inspectorWidth", isPositiveFiniteNumber) &&
    optionalField(value, "sidebarOpen", (field) => typeof field === "boolean") &&
    optionalField(value, "sidebarView", isSidebarView) &&
    optionalField(value, "inspectorOpen", (field) => typeof field === "boolean") &&
    optionalField(value, "inspectorTab", isInspectorTab) &&
    optionalField(value, "selection", isSelection) &&
    optionalField(value, "editingFile", (field) => field === null || isEditingFile(field)) &&
    optionalField(value, "diffFile", (field) => field === null || isDiffFile(field)) &&
    optionalField(value, "window", isWindowLayout)
  );
}

function normalizedPreferences(value: unknown): DashboardLayoutPreferences {
  const source = isRecord(value) ? value : {};
  const normalized: DashboardLayoutPreferences = {
    columnOrder: normalizeColumnOrder(source.columnOrder),
  };

  for (const key of [
    "left",
    "right",
    "gitHeight",
    "sectionSplit",
    "automationHeight",
    "scratchWidth",
    "fileTreeWidth",
    "editorWidth",
    "sidebarWidth",
    "inspectorWidth",
  ] as const) {
    const field = source[key];
    if (isPositiveFiniteNumber(field)) normalized[key] = field;
  }

  if (Array.isArray(source.sessionOrder)) {
    normalized.sessionOrder = source.sessionOrder.filter(
      (item): item is string => typeof item === "string",
    );
  }
  if (Array.isArray(source.collapsedProjects)) {
    normalized.collapsedProjects = source.collapsedProjects.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    );
  }
  if (Array.isArray(source.pinnedItems)) {
    const seen = new Set<string>();
    normalized.pinnedItems = source.pinnedItems.filter((item): item is PinnedItem => {
      if (!isPinnedItem(item)) return false;
      const key = item.kind === "session" ? `session:${item.name}` : `terminal:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (typeof source.automationSectionCollapsed === "boolean") {
    normalized.automationSectionCollapsed = source.automationSectionCollapsed;
  }
  if (typeof source.scratchCollapsed === "boolean") {
    normalized.scratchCollapsed = source.scratchCollapsed;
  }
  if (typeof source.fileBrowserOpen === "boolean") {
    normalized.fileBrowserOpen = source.fileBrowserOpen;
  }
  if (typeof source.sidebarOpen === "boolean") normalized.sidebarOpen = source.sidebarOpen;
  if (isSidebarView(source.sidebarView)) normalized.sidebarView = source.sidebarView;
  if (typeof source.inspectorOpen === "boolean") normalized.inspectorOpen = source.inspectorOpen;
  if (isInspectorTab(source.inspectorTab)) normalized.inspectorTab = source.inspectorTab;
  if (isSelection(source.selection)) normalized.selection = source.selection;

  if (source.editingFile === null) {
    normalized.editingFile = null;
  } else if (isEditingFile(source.editingFile)) {
    normalized.editingFile = source.editingFile;
  } else if (typeof source.editingFile === "string") {
    normalized.editingFile = { path: source.editingFile, hostId: null };
  }

  if (source.diffFile === null) {
    normalized.diffFile = null;
  } else if (isDiffFile(source.diffFile)) {
    normalized.diffFile = source.diffFile;
  }
  if (isWindowLayout(source.window)) normalized.window = source.window;

  return normalized;
}

export function createDashboardLayoutV2(
  preferences: DashboardLayoutPreferences,
): DashboardLayoutV2 {
  return {
    schemaVersion: DASHBOARD_LAYOUT_SCHEMA_VERSION,
    ...normalizedPreferences(preferences),
  };
}

export function migrateDashboardLayout(value: unknown): DashboardLayoutV2 {
  try {
    if (isDashboardLayoutV2(value)) return value;
    if (
      isRecord(value) &&
      hasOwn(value, "schemaVersion") &&
      value.schemaVersion !== DASHBOARD_LAYOUT_SCHEMA_VERSION
    ) {
      return createDashboardLayoutV2({ columnOrder: [...DEFAULT_COLUMN_ORDER] });
    }
    return createDashboardLayoutV2(normalizedPreferences(value));
  } catch {
    return createDashboardLayoutV2({ columnOrder: [...DEFAULT_COLUMN_ORDER] });
  }
}
