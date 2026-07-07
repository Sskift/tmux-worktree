import { useRef, useState, useCallback, useEffect, type PointerEvent } from "react";

const DRAG_THRESHOLD = 5;

export function useSortable<T>(
  items: T[],
  onReorder: (items: T[]) => void,
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const pendingRef = useRef<{ index: number; startY: number } | null>(null);
  const draggingRef = useRef(false);
  const listRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const onPointerDown = useCallback(
    (index: number) => (e: PointerEvent) => {
      if (e.button !== 0) return;
      const tag = (e.target as HTMLElement).closest("button");
      if (tag) return;
      pendingRef.current = { index, startY: e.clientY };
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && dragIndex === null) {
        if (Math.abs(e.clientY - pending.startY) >= DRAG_THRESHOLD) {
          setDragIndex(pending.index);
          setOverIndex(pending.index);
          draggingRef.current = true;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
          pendingRef.current = null;
        }
        return;
      }

      if (dragIndex === null) return;
      const list = listRef.current;
      if (!list) return;
      const indexedChildren = Array.from(
        list.querySelectorAll<HTMLElement>("[data-sort-index]"),
      );
      const children =
        indexedChildren.length > 0
          ? indexedChildren
          : (Array.from(list.children) as HTMLElement[]);
      const y = e.clientY;
      let best = dragIndex;
      let bestDist = Infinity;
      for (let i = 0; i < children.length; i++) {
        const rect = children[i].getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        const dist = Math.abs(y - mid);
        if (dist < bestDist) {
          bestDist = dist;
          const sortIndex = children[i].dataset.sortIndex;
          best = sortIndex === undefined ? i : Number(sortIndex);
        }
      }
      setOverIndex(best);
    };

    const onUp = () => {
      if (pendingRef.current) {
        pendingRef.current = null;
        return;
      }
      if (dragIndex !== null) {
        const from = dragIndex;
        const to = overIndex ?? from;
        if (from !== to) {
          const copy = [...itemsRef.current];
          const [moved] = copy.splice(from, 1);
          copy.splice(to, 0, moved);
          onReorderRef.current(copy);
        }
        setDragIndex(null);
        setOverIndex(null);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        requestAnimationFrame(() => { draggingRef.current = false; });
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragIndex, overIndex]);

  return { listRef, onPointerDown, dragIndex, overIndex, draggingRef };
}
