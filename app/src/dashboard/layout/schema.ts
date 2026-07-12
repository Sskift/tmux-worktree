import type { PinnedItem, Selection } from "../model/selection";
import type {
  DashboardLayoutPreferences,
  DiffFile,
  EditingFile,
  LayoutColumn,
  PersistedInspectorTab,
  SidebarView,
  WindowLayout,
} from "./types";

export const DASHBOARD_LAYOUT_SCHEMA_VERSION = 2 as const;

export const DEFAULT_COLUMN_ORDER: LayoutColumn[] = [
  "file",
  "main",
  "scratch",
  "editor",
];

export type DashboardLayoutV2 = DashboardLayoutPreferences & {
  schemaVersion: typeof DASHBOARD_LAYOUT_SCHEMA_VERSION;
  [key: string]: unknown;
};

export type DashboardLayoutExtensions = Readonly<Record<string, unknown>>;

export type DashboardLayoutInvalidReason =
  | "not_object"
  | "invalid_version_marker"
  | "conflicting_version_markers"
  | "invalid_current_layout";

export type DashboardLayoutDecodeOutcome =
  | {
      kind: "compatible";
      source: "legacy" | "current";
      layout: DashboardLayoutV2;
      extensions: DashboardLayoutExtensions;
    }
  | {
      kind: "future";
      version: number;
      marker: "schemaVersion" | "version";
    }
  | {
      kind: "invalid";
      reason: DashboardLayoutInvalidReason;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

type DashboardLayoutRecordSnapshot =
  | { kind: "snapshot"; value: Record<string, unknown> }
  | { kind: "not_object" }
  | { kind: "unsafe" };

function snapshotDashboardLayoutRecord(value: unknown): DashboardLayoutRecordSnapshot {
  if (!value || typeof value !== "object") return { kind: "not_object" };

  try {
    if (Array.isArray(value)) return { kind: "not_object" };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { kind: "not_object" };
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return { kind: "unsafe" };
      if (typeof key !== "string") continue;
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: descriptor.enumerable,
        value: descriptor.value,
        writable: false,
      });
    }
    return { kind: "snapshot", value: snapshot };
  } catch {
    return { kind: "unsafe" };
  }
}

function canonicalOwnDataRecord<T extends object>(value: T): T {
  const record = Object.create(null) as T;
  for (const [key, field] of Object.entries(value)) {
    defineOwnDataProperty(record, key as keyof T, field as T[keyof T]);
  }
  return record;
}

function defineOwnDataProperty<T extends object, K extends keyof T>(
  record: T,
  key: K,
  value: T[K],
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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

function normalizedSelection(value: unknown): Selection | undefined {
  if (value === null) return null;
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind !== "snapshot") return undefined;
  const record = snapshot.value;
  if (record.kind === "session" && typeof record.name === "string") {
    return canonicalOwnDataRecord({ kind: "session" as const, name: record.name });
  }
  if (record.kind === "terminal" && typeof record.id === "string") {
    return canonicalOwnDataRecord({ kind: "terminal" as const, id: record.id });
  }
  if (record.kind === "automation" && typeof record.id === "string") {
    return canonicalOwnDataRecord({ kind: "automation" as const, id: record.id });
  }
  return undefined;
}

function isSelection(value: unknown): value is Selection {
  return normalizedSelection(value) !== undefined;
}

function normalizedPinnedItem(value: unknown): PinnedItem | undefined {
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind !== "snapshot") return undefined;
  const record = snapshot.value;
  if (record.kind === "session" && typeof record.name === "string" && record.name.length > 0) {
    return canonicalOwnDataRecord({ kind: "session" as const, name: record.name });
  }
  if (record.kind === "terminal" && typeof record.id === "string" && record.id.length > 0) {
    return canonicalOwnDataRecord({ kind: "terminal" as const, id: record.id });
  }
  return undefined;
}

function isPinnedItem(value: unknown): value is PinnedItem {
  return normalizedPinnedItem(value) !== undefined;
}

function isPinnedItems(value: unknown): value is PinnedItem[] {
  return Array.isArray(value) && value.every(isPinnedItem);
}

function normalizedEditingFile(value: unknown): EditingFile | undefined {
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind !== "snapshot") return undefined;
  const record = snapshot.value;
  if (typeof record.path !== "string" || !hasValidHostId(record)) return undefined;
  const validLocation = (field: unknown) =>
    field === undefined ||
    (typeof field === "number" && Number.isSafeInteger(field) && field > 0);
  if (!validLocation(record.line) || !validLocation(record.column)) return undefined;
  const editingFile = canonicalOwnDataRecord<EditingFile>({ path: record.path });
  if (hasOwn(record, "hostId")) {
    defineOwnDataProperty(editingFile, "hostId", record.hostId as string | null | undefined);
  }
  if (hasOwn(record, "line")) {
    defineOwnDataProperty(editingFile, "line", record.line as number | undefined);
  }
  if (hasOwn(record, "column")) {
    defineOwnDataProperty(editingFile, "column", record.column as number | undefined);
  }
  return editingFile;
}

function isEditingFile(value: unknown): value is EditingFile {
  return normalizedEditingFile(value) !== undefined;
}

function normalizedDiffFile(value: unknown): DiffFile | undefined {
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind !== "snapshot") return undefined;
  const record = snapshot.value;
  if (
    typeof record.path !== "string" ||
    typeof record.cwd !== "string" ||
    !hasValidHostId(record)
  ) {
    return undefined;
  }
  const diffFile = canonicalOwnDataRecord<DiffFile>({
    path: record.path,
    cwd: record.cwd,
  });
  if (hasOwn(record, "hostId")) {
    defineOwnDataProperty(diffFile, "hostId", record.hostId as string | null | undefined);
  }
  return diffFile;
}

function isDiffFile(value: unknown): value is DiffFile {
  return normalizedDiffFile(value) !== undefined;
}

function normalizedWindowLayout(value: unknown): WindowLayout | undefined {
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind !== "snapshot") return undefined;
  const record = snapshot.value;
  if (
    !isPositiveFiniteNumber(record.width) ||
    !isPositiveFiniteNumber(record.height) ||
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    typeof record.maximized !== "boolean"
  ) {
    return undefined;
  }
  return canonicalOwnDataRecord({
    width: record.width,
    height: record.height,
    x: record.x,
    y: record.y,
    maximized: record.maximized,
  });
}

function isWindowLayout(value: unknown): value is WindowLayout {
  return normalizedWindowLayout(value) !== undefined;
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
  if (
    !isRecord(value) ||
    !hasOwn(value, "schemaVersion") ||
    value.schemaVersion !== DASHBOARD_LAYOUT_SCHEMA_VERSION ||
    !hasOwn(value, "columnOrder")
  ) {
    return false;
  }
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
  const snapshot = snapshotDashboardLayoutRecord(value);
  const source = snapshot.kind === "snapshot"
    ? snapshot.value
    : Object.create(null) as Record<string, unknown>;
  const normalized = canonicalOwnDataRecord<DashboardLayoutPreferences>({
    columnOrder: normalizeColumnOrder(source.columnOrder),
  });

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
    if (isPositiveFiniteNumber(field)) defineOwnDataProperty(normalized, key, field);
  }

  if (Array.isArray(source.sessionOrder)) {
    defineOwnDataProperty(
      normalized,
      "sessionOrder",
      source.sessionOrder.filter((item): item is string => typeof item === "string"),
    );
  }
  if (Array.isArray(source.collapsedProjects)) {
    defineOwnDataProperty(
      normalized,
      "collapsedProjects",
      source.collapsedProjects.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      ),
    );
  }
  if (Array.isArray(source.pinnedItems)) {
    const seen = new Set<string>();
    defineOwnDataProperty(
      normalized,
      "pinnedItems",
      source.pinnedItems.flatMap((item) => {
        const normalizedItem = normalizedPinnedItem(item);
        if (!normalizedItem) return [];
        const key = normalizedItem.kind === "session"
          ? `session:${normalizedItem.name}`
          : `terminal:${normalizedItem.id}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [normalizedItem];
      }),
    );
  }
  if (typeof source.automationSectionCollapsed === "boolean") {
    defineOwnDataProperty(
      normalized,
      "automationSectionCollapsed",
      source.automationSectionCollapsed,
    );
  }
  if (typeof source.scratchCollapsed === "boolean") {
    defineOwnDataProperty(normalized, "scratchCollapsed", source.scratchCollapsed);
  }
  if (typeof source.fileBrowserOpen === "boolean") {
    defineOwnDataProperty(normalized, "fileBrowserOpen", source.fileBrowserOpen);
  }
  if (typeof source.sidebarOpen === "boolean") {
    defineOwnDataProperty(normalized, "sidebarOpen", source.sidebarOpen);
  }
  if (isSidebarView(source.sidebarView)) {
    defineOwnDataProperty(normalized, "sidebarView", source.sidebarView);
  }
  if (typeof source.inspectorOpen === "boolean") {
    defineOwnDataProperty(normalized, "inspectorOpen", source.inspectorOpen);
  }
  if (isInspectorTab(source.inspectorTab)) {
    defineOwnDataProperty(normalized, "inspectorTab", source.inspectorTab);
  }
  const selection = normalizedSelection(source.selection);
  if (selection !== undefined) defineOwnDataProperty(normalized, "selection", selection);

  if (source.editingFile === null) {
    defineOwnDataProperty(normalized, "editingFile", null);
  } else {
    const editingFile = normalizedEditingFile(source.editingFile);
    if (editingFile) defineOwnDataProperty(normalized, "editingFile", editingFile);
  }
  if (normalized.editingFile === undefined && typeof source.editingFile === "string") {
    defineOwnDataProperty(
      normalized,
      "editingFile",
      canonicalOwnDataRecord({
        path: source.editingFile,
        hostId: null,
      }),
    );
  }

  if (source.diffFile === null) {
    defineOwnDataProperty(normalized, "diffFile", null);
  } else {
    const diffFile = normalizedDiffFile(source.diffFile);
    if (diffFile) defineOwnDataProperty(normalized, "diffFile", diffFile);
  }
  const windowLayout = normalizedWindowLayout(source.window);
  if (windowLayout) defineOwnDataProperty(normalized, "window", windowLayout);

  return normalized;
}

const DASHBOARD_LAYOUT_KNOWN_KEYS = new Set<string>([
  "schemaVersion",
  "version",
  "left",
  "right",
  "gitHeight",
  "sectionSplit",
  "automationHeight",
  "sessionOrder",
  "collapsedProjects",
  "pinnedItems",
  "automationSectionCollapsed",
  "columnOrder",
  "scratchCollapsed",
  "scratchWidth",
  "fileBrowserOpen",
  "fileTreeWidth",
  "editorWidth",
  "sidebarWidth",
  "inspectorWidth",
  "sidebarOpen",
  "sidebarView",
  "inspectorOpen",
  "inspectorTab",
  "selection",
  "editingFile",
  "diffFile",
  "window",
]);

const EMPTY_DASHBOARD_LAYOUT_EXTENSIONS: DashboardLayoutExtensions = Object.freeze({});

function copyDashboardLayoutExtensions(value: unknown): DashboardLayoutExtensions {
  const extensions: Record<string, unknown> = {};
  if (!value || typeof value !== "object") return extensions;
  try {
    if (Array.isArray(value)) return extensions;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        DASHBOARD_LAYOUT_KNOWN_KEYS.has(key)
      ) {
        continue;
      }
      Object.defineProperty(extensions, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
  } catch {
    return {};
  }
  return extensions;
}

function migrateLegacyDashboardLayout(
  value: Record<string, unknown>,
  extensions: DashboardLayoutExtensions,
): DashboardLayoutV2 {
  return createDashboardLayoutV2(normalizedPreferences(value), extensions);
}

export function createDashboardLayoutV2(
  preferences: DashboardLayoutPreferences,
  extensions: DashboardLayoutExtensions = EMPTY_DASHBOARD_LAYOUT_EXTENSIONS,
): DashboardLayoutV2 {
  const filteredExtensions = copyDashboardLayoutExtensions(extensions);
  const normalized = normalizedPreferences(preferences);
  const layout = Object.create(null) as DashboardLayoutV2;
  for (const [key, field] of Object.entries(filteredExtensions)) {
    Object.defineProperty(layout, key, {
      configurable: true,
      enumerable: true,
      value: field,
      writable: true,
    });
  }
  Object.defineProperty(layout, "schemaVersion", {
    configurable: true,
    enumerable: true,
    value: DASHBOARD_LAYOUT_SCHEMA_VERSION,
    writable: true,
  });
  for (const [key, field] of Object.entries(normalized)) {
    Object.defineProperty(layout, key, {
      configurable: true,
      enumerable: true,
      value: field,
      writable: true,
    });
  }
  return layout;
}

export function decodeDashboardLayout(value: unknown): DashboardLayoutDecodeOutcome {
  const snapshot = snapshotDashboardLayoutRecord(value);
  if (snapshot.kind === "not_object") {
    return { kind: "invalid", reason: "not_object" };
  }
  if (snapshot.kind === "unsafe") {
    return { kind: "invalid", reason: "invalid_current_layout" };
  }
  const record = snapshot.value;

  const schemaVersion = record.schemaVersion;
  const legacyVersion = record.version;
  const hasSchemaVersion = hasOwn(record, "schemaVersion");
  const hasLegacyVersion = hasOwn(record, "version");

  if (
    (hasSchemaVersion && !(
      typeof schemaVersion === "number" &&
      Number.isSafeInteger(schemaVersion) &&
      schemaVersion >= 1
    )) ||
    (hasLegacyVersion && !(
      typeof legacyVersion === "number" &&
      Number.isSafeInteger(legacyVersion) &&
      legacyVersion >= 1
    ))
  ) {
    return { kind: "invalid", reason: "invalid_version_marker" };
  }

  if (hasSchemaVersion && hasLegacyVersion && schemaVersion !== legacyVersion) {
    return { kind: "invalid", reason: "conflicting_version_markers" };
  }

  const effectiveVersion = hasSchemaVersion
    ? schemaVersion as number
    : hasLegacyVersion
      ? legacyVersion as number
      : 1;
  const marker = hasSchemaVersion ? "schemaVersion" : "version";
  if (effectiveVersion > DASHBOARD_LAYOUT_SCHEMA_VERSION) {
    return {
      kind: "future",
      version: effectiveVersion,
      marker,
    };
  }

  const extensions = copyDashboardLayoutExtensions(record);
  if (hasSchemaVersion && effectiveVersion === DASHBOARD_LAYOUT_SCHEMA_VERSION) {
    try {
      if (!isDashboardLayoutV2(record)) {
        return { kind: "invalid", reason: "invalid_current_layout" };
      }
      return {
        kind: "compatible",
        source: "current",
        layout: createDashboardLayoutV2(record as DashboardLayoutPreferences, extensions),
        extensions,
      };
    } catch {
      return { kind: "invalid", reason: "invalid_current_layout" };
    }
  }

  try {
    return {
      kind: "compatible",
      source: "legacy",
      layout: migrateLegacyDashboardLayout(record, extensions),
      extensions,
    };
  } catch {
    return { kind: "invalid", reason: "invalid_current_layout" };
  }
}
