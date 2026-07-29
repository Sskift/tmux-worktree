import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

const DRAG_THRESHOLD = 5;

export function moveSortableItem<T>(
  items: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return [...items];
  }
  const reordered = [...items];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  return reordered;
}

export type SortableMove<T> = Readonly<{
  fromIndex: number;
  item: T;
  items: T[];
  toIndex: number;
}>;

export function resolveSortableMove<T>(
  items: readonly T[],
  sourceKey: string,
  targetKey: string,
  keyOf: (item: T) => string,
  canMove?: (fromIndex: number, toIndex: number) => boolean,
): SortableMove<T> | null {
  const fromIndex = items.findIndex((item) => keyOf(item) === sourceKey);
  const toIndex = items.findIndex((item) => keyOf(item) === targetKey);
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex === toIndex ||
    canMove?.(fromIndex, toIndex) === false
  ) {
    return null;
  }
  return {
    fromIndex,
    item: items[fromIndex],
    items: moveSortableItem(items, fromIndex, toIndex),
    toIndex,
  };
}

export type SortableMoveInput = "keyboard" | "pointer";

type SortableOptions<T> = Readonly<{
  dragLease?: MutableRefObject<object | null>;
  itemSelector?: string;
  keyOf: (item: T) => string;
  canMove?: (fromIndex: number, toIndex: number) => boolean;
  onMove?: (move: SortableMove<T>, input: SortableMoveInput) => void;
}>;

type PendingPointer = {
  captureTarget: HTMLElement;
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
};

type ActivePointer = {
  captureTarget: HTMLElement;
  key: string;
  pointerId: number;
  previousCursor: string;
  previousUserSelect: string;
};

function releasePointerCapture(
  target: HTMLElement,
  pointerId: number,
): void {
  try {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  } catch {
    // A detached handle or a WebView that already released capture needs no repair.
  }
}

export function useSortable<T>(
  items: readonly T[],
  onReorder: (items: T[]) => void,
  options: SortableOptions<T>,
) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const overKeyRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingPointer | null>(null);
  const activeRef = useRef<ActivePointer | null>(null);
  const ownerRef = useRef<object>({});
  const listRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef(items);
  const onReorderRef = useRef(onReorder);
  const optionsRef = useRef(options);
  itemsRef.current = items;
  onReorderRef.current = onReorder;
  optionsRef.current = options;

  const dragIndex = dragKey === null
    ? null
    : items.findIndex((item) => options.keyOf(item) === dragKey);
  const overIndex = overKey === null
    ? null
    : items.findIndex((item) => options.keyOf(item) === overKey);

  const setListRef = useCallback((node: HTMLElement | null) => {
    listRef.current = node;
  }, []);

  const publishMove = useCallback((move: SortableMove<T>, input: SortableMoveInput) => {
    onReorderRef.current(move.items);
    optionsRef.current.onMove?.(move, input);
  }, []);

  const onPointerDown = useCallback(
    (key: string) => (event: ReactPointerEvent<HTMLElement>) => {
      const dragLease = optionsRef.current.dragLease;
      if (
        event.button !== 0 ||
        event.isPrimary === false ||
        pendingRef.current !== null ||
        activeRef.current !== null ||
        (dragLease !== undefined &&
          dragLease.current !== null &&
          dragLease.current !== ownerRef.current) ||
        !itemsRef.current.some((item) => optionsRef.current.keyOf(item) === key)
      ) {
        return;
      }
      const captureTarget = event.currentTarget;
      if (optionsRef.current.dragLease) {
        optionsRef.current.dragLease.current = ownerRef.current;
      }
      pendingRef.current = {
        captureTarget,
        key,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      try {
        captureTarget.setPointerCapture(event.pointerId);
      } catch {
        // Document listeners remain the fallback on WebViews without capture.
      }
    },
    [],
  );

  const onHandleKeyDown = useCallback(
    (key: string) => (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const dragLease = optionsRef.current.dragLease;
      if (dragLease !== undefined && dragLease.current !== null) return;
      const direction = event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowDown"
          ? 1
          : 0;
      if (direction === 0) return;
      event.preventDefault();

      const currentItems = itemsRef.current;
      const keyOf = optionsRef.current.keyOf;
      const fromIndex = currentItems.findIndex((item) => keyOf(item) === key);
      const toIndex = fromIndex + direction;
      if (fromIndex < 0 || toIndex < 0 || toIndex >= currentItems.length) return;
      const targetKey = keyOf(currentItems[toIndex]);
      const move = resolveSortableMove(
        currentItems,
        key,
        targetKey,
        keyOf,
        optionsRef.current.canMove,
      );
      if (move) publishMove(move, "keyboard");
    },
    [publishMove],
  );

  useEffect(() => {
    const clearVisualState = () => {
      overKeyRef.current = null;
      setDragKey(null);
      setOverKey(null);
    };

    const restoreDocumentDragState = (active: ActivePointer) => {
      document.body.style.userSelect = active.previousUserSelect;
      document.body.style.cursor = active.previousCursor;
    };

    const releaseDragLease = () => {
      const lease = optionsRef.current.dragLease;
      if (lease?.current === ownerRef.current) lease.current = null;
    };

    const cancelPointer = (pointerId?: number, updateVisualState = true) => {
      const pending = pendingRef.current;
      if (pending && (pointerId === undefined || pending.pointerId === pointerId)) {
        pendingRef.current = null;
        releasePointerCapture(pending.captureTarget, pending.pointerId);
        releaseDragLease();
      }

      const active = activeRef.current;
      if (active && (pointerId === undefined || active.pointerId === pointerId)) {
        activeRef.current = null;
        if (updateVisualState) clearVisualState();
        else overKeyRef.current = null;
        restoreDocumentDragState(active);
        releasePointerCapture(active.captureTarget, active.pointerId);
        releaseDragLease();
      }
    };

    const targetKeyAtPoint = (
      clientX: number,
      clientY: number,
      sourceKey: string,
    ): string | null => {
      const list = listRef.current;
      const hit = document.elementFromPoint(clientX, clientY);
      const selector = optionsRef.current.itemSelector ?? "[data-sort-key]";
      const target = hit?.closest<HTMLElement>(selector) ?? null;
      const targetKey = target && list?.contains(target)
        ? target.dataset.sortKey ?? null
        : null;
      if (targetKey === null) return null;

      const currentItems = itemsRef.current;
      const keyOf = optionsRef.current.keyOf;
      const fromIndex = currentItems.findIndex((item) => keyOf(item) === sourceKey);
      const toIndex = currentItems.findIndex((item) => keyOf(item) === targetKey);
      return fromIndex >= 0 &&
        toIndex >= 0 &&
        optionsRef.current.canMove?.(fromIndex, toIndex) !== false
        ? targetKey
        : null;
    };

    const onMove = (event: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      if (pending) {
        if (pending.pointerId !== event.pointerId) return;
        if (
          Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) <
          DRAG_THRESHOLD
        ) {
          return;
        }
        if (!itemsRef.current.some((item) => optionsRef.current.keyOf(item) === pending.key)) {
          cancelPointer(event.pointerId);
          return;
        }
        pendingRef.current = null;
        const active: ActivePointer = {
          captureTarget: pending.captureTarget,
          key: pending.key,
          pointerId: pending.pointerId,
          previousCursor: document.body.style.cursor,
          previousUserSelect: document.body.style.userSelect,
        };
        activeRef.current = active;
        overKeyRef.current = pending.key;
        setDragKey(pending.key);
        setOverKey(pending.key);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }

      const active = activeRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const targetKey = targetKeyAtPoint(event.clientX, event.clientY, active.key);
      overKeyRef.current = targetKey;
      setOverKey(targetKey);
    };

    const onUp = (event: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      if (pending?.pointerId === event.pointerId) {
        pendingRef.current = null;
        releasePointerCapture(pending.captureTarget, pending.pointerId);
        releaseDragLease();
        return;
      }

      const active = activeRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const targetKey = targetKeyAtPoint(event.clientX, event.clientY, active.key);
      activeRef.current = null;
      clearVisualState();
      restoreDocumentDragState(active);
      releasePointerCapture(active.captureTarget, active.pointerId);
      releaseDragLease();

      if (targetKey === null) return;
      const currentItems = itemsRef.current;
      const move = resolveSortableMove(
        currentItems,
        active.key,
        targetKey,
        optionsRef.current.keyOf,
        optionsRef.current.canMove,
      );
      if (move) publishMove(move, "pointer");
    };

    const onCancel = (event: globalThis.PointerEvent) => cancelPointer(event.pointerId);
    const onLostPointerCapture = (event: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      const active = activeRef.current;
      if (pending?.pointerId === event.pointerId || active?.pointerId === event.pointerId) {
        cancelPointer(event.pointerId);
      }
    };
    const onBlur = () => cancelPointer();

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("lostpointercapture", onLostPointerCapture);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("lostpointercapture", onLostPointerCapture);
      window.removeEventListener("blur", onBlur);
      cancelPointer(undefined, false);
    };
  }, [publishMove]);

  return {
    dragIndex: dragIndex !== null && dragIndex >= 0 ? dragIndex : null,
    dragKey,
    overIndex: overIndex !== null && overIndex >= 0 ? overIndex : null,
    overKey,
    onHandleKeyDown,
    onPointerDown,
    setListRef,
  };
}
