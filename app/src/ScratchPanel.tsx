import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Plus, X } from "lucide-react";
import type { HostConfig } from "./platform";
import { Terminal } from "./Terminal";
import { buildSshShellArgs } from "./terminal/attach";
import {
  SCRATCH_PANEL_LIMITS,
  scratchPanelMaximumWidth,
  scratchPanelWidthFromKey,
  scratchPanelWidthFromPointer,
} from "./dashboard/layout/scratchGeometry";

export type ScratchContext = { cwd: string; host: HostConfig | null };

type ScratchTerm = { id: string; label: string };
type ScratchState = { list: ScratchTerm[]; nextNum: number };
let scratchIdCounter = 0;

type ScratchPanelProps = {
  selectionKey: string | null;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  width: number;
  onWidthChange: (width: number) => void;
  resolveContext: (key: string) => ScratchContext | null;
  ownerEpochKey: string;
  interactionBlocked: boolean;
  metadataPending: boolean;
  onOpenFile: (path: string, line?: number, col?: number, hostId?: string | null) => void;
  workspaceRef: RefObject<HTMLDivElement | null>;
};

export function ScratchPanel({
  selectionKey,
  collapsed,
  onCollapsedChange,
  width,
  onWidthChange,
  resolveContext,
  ownerEpochKey,
  interactionBlocked,
  metadataPending,
  onOpenFile,
  workspaceRef,
}: ScratchPanelProps) {
  const [scratchTerminals, setScratchTerminals] = useState<Map<string, ScratchState>>(new Map());
  const scratchSectionsRef = useRef<HTMLDivElement | null>(null);

  const ensureScratch = useCallback((key: string) => {
    setScratchTerminals((prev) => {
      if (prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, {
        list: [{ id: `scratch-${++scratchIdCounter}`, label: "zsh 1" }],
        nextNum: 2,
      });
      return next;
    });
  }, []);

  useEffect(() => {
    if (selectionKey) ensureScratch(selectionKey);
  }, [selectionKey, ensureScratch]);

  const addScratchTerminal = useCallback(() => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey) ?? { list: [], nextNum: 1 };
      const num = state.nextNum;
      const next = new Map(prev);
      next.set(selectionKey, {
        list: [...state.list, { id: `scratch-${++scratchIdCounter}`, label: `zsh ${num}` }],
        nextNum: num + 1,
      });
      return next;
    });
    // Reset inline flex so all sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const removeScratchTerminal = useCallback((scratchId: string) => {
    if (!selectionKey) return;
    setScratchTerminals((prev) => {
      const state = prev.get(selectionKey);
      if (!state || state.list.length <= 1) return prev;
      const next = new Map(prev);
      next.set(selectionKey, {
        ...state,
        list: state.list.filter((s) => s.id !== scratchId),
      });
      return next;
    });
    // Reset inline flex so remaining sections share space equally
    const container = scratchSectionsRef.current;
    if (container) {
      for (const child of Array.from(container.children) as HTMLElement[]) {
        child.style.flex = "";
      }
    }
  }, [selectionKey]);

  const startScratchSplit = (index: number) => (e: ReactMouseEvent) => {
    e.preventDefault();
    const container = scratchSectionsRef.current;
    if (!container) return;
    const sections = Array.from(container.children) as HTMLElement[];
    if (index < 1 || index >= sections.length) return;
    const prevSection = sections[index - 1];
    const currSection = sections[index];
    const startY = e.clientY;
    const startPrevH = prevSection.getBoundingClientRect().height;
    const startCurrH = currSection.getBoundingClientRect().height;
    const totalH = startPrevH + startCurrH;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      const newPrevH = Math.max(60, Math.min(totalH - 60, startPrevH + dy));
      const newCurrH = totalH - newPrevH;
      prevSection.style.flex = `0 0 ${newPrevH}px`;
      currSection.style.flex = `0 0 ${newCurrH}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startScratchResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    const containerWidth = workspaceRef.current?.getBoundingClientRect().width;
    target.setPointerCapture?.(event.pointerId);
    document.body.dataset.dashboardResizing = "scratch";

    const handlePointerMove = (nextEvent: globalThis.PointerEvent) => {
      onWidthChange(
        scratchPanelWidthFromPointer(
          startWidth,
          nextEvent.clientX - startX,
          containerWidth,
        ),
      );
    };
    const finish = () => {
      if (target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      delete document.body.dataset.dashboardResizing;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [width, onWidthChange, workspaceRef]);

  const resizeScratchFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const containerWidth = workspaceRef.current?.getBoundingClientRect().width;
    const next = scratchPanelWidthFromKey(
      width,
      event.key,
      event.shiftKey,
      containerWidth,
    );
    if (next === null) return;
    event.preventDefault();
    onWidthChange(next);
  }, [width, onWidthChange, workspaceRef]);

  const hidden = metadataPending || collapsed || !selectionKey;

  return (
    <>
      <button
        className="dashboard-scratch__resize-handle"
        type="button"
        role="separator"
        aria-label="Resize Scratch panel"
        aria-controls="dashboard-scratch-panel"
        aria-orientation="vertical"
        aria-valuemin={Math.min(SCRATCH_PANEL_LIMITS.min, scratchPanelMaximumWidth(workspaceRef.current?.clientWidth))}
        aria-valuemax={scratchPanelMaximumWidth(workspaceRef.current?.clientWidth)}
        aria-valuenow={width}
        hidden={hidden}
        onPointerDown={startScratchResize}
        onKeyDown={resizeScratchFromKeyboard}
      />

      <aside
        id="dashboard-scratch-panel"
        className="dashboard-scratch"
        aria-label="Scratch terminals"
        hidden={hidden}
      >
        <div className="dashboard-scratch__header">
          <strong>Scratch</strong>
          <div>
            <button
              type="button"
              onClick={addScratchTerminal}
              aria-label="Add scratch terminal"
              title="Add scratch terminal"
            >
              <Plus aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={() => onCollapsedChange(true)}
              aria-label="Close scratch panel"
              title="Close scratch panel"
            >
              <X aria-hidden="true" size={15} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        {Array.from(scratchTerminals.entries()).map(([key, state]) => {
          const isActive = key === selectionKey;
          const scratchContext = resolveContext(key);
          if (!scratchContext) return null;
          return (
            <div
              key={`${ownerEpochKey}:${key}`}
              className="scratch__sections"
              ref={isActive ? scratchSectionsRef : undefined}
              style={{ display: isActive ? "flex" : "none" }}
            >
              {state.list.map((scratch, index) => (
                <div key={scratch.id} className="scratch__section">
                  {index > 0 && (
                    <button
                      className="dashboard-scratch__split-handle"
                      type="button"
                      role="separator"
                      aria-label={`Resize ${scratch.label}`}
                      aria-orientation="horizontal"
                      onMouseDown={startScratchSplit(index)}
                    />
                  )}
                  <div className="dashboard-scratch__terminal-header">
                    <span>{scratch.label}</span>
                    {state.list.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeScratchTerminal(scratch.id)}
                        aria-label={"Close " + scratch.label}
                        title={"Close " + scratch.label}
                      >
                        <X aria-hidden="true" size={13} strokeWidth={1.8} />
                      </button>
                    )}
                  </div>
                  <div className="scratch__term">
                    <Terminal
                      cmd={scratchContext.host ? "ssh" : "/bin/zsh"}
                      args={
                        scratchContext.host
                          ? buildSshShellArgs(scratchContext.host, scratchContext.cwd)
                          : ["-l"]
                      }
                      cwd={scratchContext.host ? undefined : scratchContext.cwd}
                      linkCwd={scratchContext.cwd}
                      active={isActive && !collapsed && !interactionBlocked}
                      hostId={scratchContext.host?.id ?? null}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </aside>
    </>
  );
}
