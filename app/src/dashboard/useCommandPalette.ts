import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LucideIcon } from "lucide-react";

export const COMMAND_PALETTE_GROUPS = [
  "actions",
  "navigate",
  "automation",
  "recent",
  "settings",
] as const;

export type CommandPaletteGroupId = (typeof COMMAND_PALETTE_GROUPS)[number];

export const COMMAND_PALETTE_GROUP_LABELS: Record<CommandPaletteGroupId, string> = {
  actions: "Actions",
  navigate: "Navigate",
  automation: "Run automation",
  recent: "Recent",
  settings: "Settings",
};

export type CommandPaletteItem = {
  /** Stable and unique across the palette. */
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  icon?: LucideIcon;
  shortcut?: readonly string[];
  disabledReason?: string;
  /** Defaults to true. Set false for commands that update the open palette in place. */
  dismissOnExecute?: boolean;
  execute: () => void | Promise<void>;
};

export type CommandPaletteGroup = {
  id: CommandPaletteGroupId;
  label: string;
  items: readonly CommandPaletteItem[];
};

export type CommandPaletteControllerState = {
  query: string;
  activeId: string | null;
};

export type CommandPaletteExecution =
  | { phase: "idle" }
  | { phase: "running"; commandId: string }
  | { phase: "error"; commandId: string; message: string };

const IDLE_EXECUTION: CommandPaletteExecution = { phase: "idle" };

function normalizeSearchValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const normalizedQuery = normalizeSearchValue(query);
  const tokens = normalizedQuery ? normalizedQuery.split(" ") : [];
  const matchingItems = items.filter((item) => {
    if (tokens.length === 0) return true;
    const searchableText = normalizeSearchValue(
      [item.label, item.detail ?? "", ...(item.keywords ?? [])].join(" "),
    );
    return tokens.every((token) => searchableText.includes(token));
  });

  return COMMAND_PALETTE_GROUPS.flatMap((groupId) => (
    matchingItems.filter((item) => item.group === groupId)
  ));
}

export function groupCommandPaletteItems(
  items: readonly CommandPaletteItem[],
): CommandPaletteGroup[] {
  const groups: CommandPaletteGroup[] = [];
  for (const groupId of COMMAND_PALETTE_GROUPS) {
    const groupedItems = items.filter((item) => item.group === groupId);
    if (groupedItems.length === 0) continue;
    groups.push({
      id: groupId,
      label: COMMAND_PALETTE_GROUP_LABELS[groupId],
      items: groupedItems,
    });
  }
  return groups;
}

function firstVisibleId(items: readonly CommandPaletteItem[]): string | null {
  return items[0]?.id ?? null;
}

export const commandPaletteController = {
  create(
    items: readonly CommandPaletteItem[],
    query = "",
  ): CommandPaletteControllerState {
    const visibleItems = filterCommandPaletteItems(items, query);
    return { query, activeId: firstVisibleId(visibleItems) };
  },

  setQuery(
    state: CommandPaletteControllerState,
    items: readonly CommandPaletteItem[],
    query: string,
  ): CommandPaletteControllerState {
    if (query === state.query) return state;
    const visibleItems = filterCommandPaletteItems(items, query);
    return { query, activeId: firstVisibleId(visibleItems) };
  },

  reconcile(
    state: CommandPaletteControllerState,
    visibleItems: readonly CommandPaletteItem[],
  ): CommandPaletteControllerState {
    if (
      state.activeId !== null
      && visibleItems.some((item) => item.id === state.activeId)
    ) {
      return state;
    }
    const activeId = firstVisibleId(visibleItems);
    return activeId === state.activeId ? state : { ...state, activeId };
  },

  select(
    state: CommandPaletteControllerState,
    visibleItems: readonly CommandPaletteItem[],
    commandId: string,
  ): CommandPaletteControllerState {
    if (
      commandId === state.activeId
      || !visibleItems.some((item) => item.id === commandId)
    ) {
      return state;
    }
    return { ...state, activeId: commandId };
  },

  move(
    state: CommandPaletteControllerState,
    visibleItems: readonly CommandPaletteItem[],
    direction: -1 | 1,
  ): CommandPaletteControllerState {
    if (visibleItems.length === 0) {
      return state.activeId === null ? state : { ...state, activeId: null };
    }

    const currentIndex = visibleItems.findIndex((item) => item.id === state.activeId);
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : visibleItems.length - 1
      : (currentIndex + direction + visibleItems.length) % visibleItems.length;
    const activeId = visibleItems[nextIndex]?.id ?? null;
    return activeId === state.activeId ? state : { ...state, activeId };
  },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The command failed without an error message.";
}

export type UseCommandPaletteOptions = {
  open: boolean;
  items: readonly CommandPaletteItem[];
  onOpenChange: (open: boolean) => void;
  initialQuery?: string;
  enableHotkey?: boolean;
};

export type UseCommandPaletteResult = {
  query: string;
  visibleItems: readonly CommandPaletteItem[];
  groups: readonly CommandPaletteGroup[];
  activeId: string | null;
  activeItem: CommandPaletteItem | null;
  execution: CommandPaletteExecution;
  setQuery: (query: string) => void;
  select: (commandId: string) => void;
  move: (direction: -1 | 1) => void;
  execute: (item: CommandPaletteItem) => Promise<void>;
  executeActive: () => Promise<void>;
  clearError: () => void;
  close: () => void;
};

export function useCommandPalette({
  open,
  items,
  onOpenChange,
  initialQuery = "",
  enableHotkey = true,
}: UseCommandPaletteOptions): UseCommandPaletteResult {
  const [controllerState, setControllerState] = useState<CommandPaletteControllerState>(
    () => commandPaletteController.create(items, initialQuery),
  );
  const [execution, setExecution] = useState<CommandPaletteExecution>(IDLE_EXECUTION);
  const runningCommandRef = useRef<string | null>(null);
  const wasOpenRef = useRef(open);

  const visibleItems = useMemo(
    () => filterCommandPaletteItems(items, controllerState.query),
    [items, controllerState.query],
  );
  const groups = useMemo(() => groupCommandPaletteItems(visibleItems), [visibleItems]);
  const activeItem = useMemo(
    () => visibleItems.find((item) => item.id === controllerState.activeId) ?? null,
    [controllerState.activeId, visibleItems],
  );

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setControllerState(commandPaletteController.create(items, initialQuery));
      if (runningCommandRef.current === null) setExecution(IDLE_EXECUTION);
    }
    wasOpenRef.current = open;
  }, [initialQuery, items, open]);

  useEffect(() => {
    setControllerState((state) => commandPaletteController.reconcile(state, visibleItems));
  }, [visibleItems]);

  useEffect(() => {
    if (!enableHotkey) return;
    const handleHotkey = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.repeat
        || event.isComposing
        || event.altKey
        || event.shiftKey
      ) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handleHotkey);
    return () => window.removeEventListener("keydown", handleHotkey);
  }, [enableHotkey, onOpenChange, open]);

  const setQuery = useCallback((query: string) => {
    if (runningCommandRef.current !== null) return;
    setControllerState((state) => commandPaletteController.setQuery(state, items, query));
    setExecution((state) => state.phase === "error" ? IDLE_EXECUTION : state);
  }, [items]);

  const select = useCallback((commandId: string) => {
    if (runningCommandRef.current !== null) return;
    setControllerState((state) => (
      commandPaletteController.select(state, visibleItems, commandId)
    ));
  }, [visibleItems]);

  const move = useCallback((direction: -1 | 1) => {
    if (runningCommandRef.current !== null) return;
    setControllerState((state) => commandPaletteController.move(state, visibleItems, direction));
  }, [visibleItems]);

  const execute = useCallback(async (item: CommandPaletteItem) => {
    if (item.disabledReason || runningCommandRef.current !== null) return;

    runningCommandRef.current = item.id;
    setExecution({ phase: "running", commandId: item.id });
    try {
      await item.execute();
      setExecution(IDLE_EXECUTION);
      if (item.dismissOnExecute !== false) onOpenChange(false);
    } catch (error) {
      setExecution({ phase: "error", commandId: item.id, message: errorMessage(error) });
    } finally {
      runningCommandRef.current = null;
    }
  }, [onOpenChange]);

  const executeActive = useCallback(async () => {
    if (activeItem) await execute(activeItem);
  }, [activeItem, execute]);

  const clearError = useCallback(() => {
    setExecution((state) => state.phase === "error" ? IDLE_EXECUTION : state);
  }, []);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return {
    query: controllerState.query,
    visibleItems,
    groups,
    activeId: controllerState.activeId,
    activeItem,
    execution,
    setQuery,
    select,
    move,
    execute,
    executeActive,
    clearError,
    close,
  };
}
