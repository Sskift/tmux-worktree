import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useEffect, useRef } from "react";
import {
  DASHBOARD_PANEL_LIMITS,
  clampDashboardPanelWidth,
  dashboardPanelWidthFromKey,
  dashboardPanelWidthFromPointer,
  type ResizablePanel,
} from "./dashboardShellModel";
import "./DashboardShell.css";

type ShellStyle = CSSProperties & {
  "--tw-sidebar-width"?: string;
  "--tw-inspector-width"?: string;
};

export type DashboardDrawer = "sidebar" | "inspector" | null;

const DRAWER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function drawerFocusableElements(drawer: HTMLElement): HTMLElement[] {
  return Array.from(
    drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE_SELECTOR),
  ).filter((element) => (
    element.getClientRects().length > 0 &&
    element.getAttribute("aria-hidden") !== "true"
  ));
}

export type DashboardShellProps = {
  titlebar?: ReactNode;
  sidebar: ReactNode;
  header: ReactNode;
  workspace: ReactNode;
  inspector?: ReactNode;
  overlays?: ReactNode;
  sidebarWidth?: number;
  inspectorWidth?: number;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  activeDrawer?: DashboardDrawer;
  blocked?: boolean;
  onSidebarWidthChange?: (width: number) => void;
  onInspectorWidthChange?: (width: number) => void;
  onDismissDrawers?: () => void;
};

export function DashboardShell({
  titlebar,
  sidebar,
  header,
  workspace,
  inspector,
  overlays,
  sidebarWidth = 280,
  inspectorWidth = 420,
  sidebarOpen,
  inspectorOpen,
  activeDrawer = null,
  blocked = false,
  onSidebarWidthChange,
  onInspectorWidthChange,
  onDismissDrawers,
}: DashboardShellProps) {
  const normalizedSidebarWidth = clampDashboardPanelWidth("sidebar", sidebarWidth);
  const normalizedInspectorWidth = clampDashboardPanelWidth("inspector", inspectorWidth);
  const style: ShellStyle = {
    "--tw-sidebar-width": `${normalizedSidebarWidth}px`,
    "--tw-inspector-width": `${normalizedInspectorWidth}px`,
  };
  const drawerOpen = sidebarOpen || inspectorOpen;
  const sidebarRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null);
  const previousDrawerRef = useRef<DashboardDrawer>(null);
  const dismissDrawersRef = useRef(onDismissDrawers);
  dismissDrawersRef.current = onDismissDrawers;

  useEffect(() => {
    const previousDrawer = previousDrawerRef.current;
    if (activeDrawer && !previousDrawer) {
      drawerReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    } else if (!activeDrawer && previousDrawer) {
      const returnTarget = drawerReturnFocusRef.current;
      drawerReturnFocusRef.current = null;
      if (returnTarget?.isConnected) {
        window.requestAnimationFrame(() => returnTarget.focus({ preventScroll: true }));
      }
    }
    previousDrawerRef.current = activeDrawer;
  }, [activeDrawer]);

  useEffect(() => {
    if (!activeDrawer || blocked) return;
    const drawer = activeDrawer === "sidebar" ? sidebarRef.current : inspectorRef.current;
    if (!drawer) return;

    const focusFrame = window.requestAnimationFrame(() => {
      drawer.focus({ preventScroll: true });
    });
    const keepFocusInDrawer = (event: FocusEvent) => {
      if (event.target instanceof Node && !drawer.contains(event.target)) {
        drawer.focus({ preventScroll: true });
      }
    };
    const handleDrawerKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && dismissDrawersRef.current) {
        event.preventDefault();
        event.stopPropagation();
        dismissDrawersRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = drawerFocusableElements(drawer);
      if (focusable.length === 0) {
        event.preventDefault();
        drawer.focus({ preventScroll: true });
        return;
      }
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? focusable.length - 1 : null
        : currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : null;
      if (nextIndex === null) return;
      event.preventDefault();
      focusable[nextIndex]?.focus({ preventScroll: true });
    };

    document.addEventListener("focusin", keepFocusInDrawer);
    document.addEventListener("keydown", handleDrawerKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("focusin", keepFocusInDrawer);
      document.removeEventListener("keydown", handleDrawerKeyDown, true);
    };
  }, [activeDrawer, blocked]);

  const startResize = (
    panel: ResizablePanel,
    currentWidth: number,
    onChange: (width: number) => void,
  ) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    document.body.dataset.dashboardResizing = panel;

    const handlePointerMove = (nextEvent: globalThis.PointerEvent) => {
      onChange(
        dashboardPanelWidthFromPointer(panel, currentWidth, nextEvent.clientX - startX),
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
  };

  const resizeFromKeyboard = (
    panel: ResizablePanel,
    currentWidth: number,
    onChange: (width: number) => void,
  ) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const nextWidth = dashboardPanelWidthFromKey(
      panel,
      currentWidth,
      event.key,
      event.shiftKey,
    );
    if (nextWidth === null) return;
    event.preventDefault();
    onChange(nextWidth);
  };

  return (
    <div
      className="tw-shell"
      data-sidebar-open={sidebarOpen}
      data-inspector-open={inspectorOpen}
      data-modal-drawer={activeDrawer ?? undefined}
      style={style}
    >
      <div
        className="tw-shell__titlebar"
        data-tauri-drag-region
        aria-hidden={blocked ? true : undefined}
        inert={blocked}
      >
        {titlebar}
      </div>

      <div
        className="tw-shell__body"
        aria-hidden={blocked ? true : undefined}
        inert={blocked}
      >
        <aside
          ref={sidebarRef}
          id="dashboard-sidebar"
          className="tw-shell__sidebar"
          aria-label="Dashboard navigation"
          aria-modal={activeDrawer === "sidebar" ? true : undefined}
          role={activeDrawer === "sidebar" ? "dialog" : undefined}
          tabIndex={activeDrawer === "sidebar" ? -1 : undefined}
          inert={activeDrawer === "inspector"}
        >
          {sidebar}
        </aside>

        {onSidebarWidthChange && (
          <button
            className="tw-shell__resize-handle tw-shell__resize-handle--sidebar"
            type="button"
            role="separator"
            aria-label="Resize dashboard sidebar"
            aria-controls="dashboard-sidebar"
            aria-orientation="vertical"
            aria-valuemin={DASHBOARD_PANEL_LIMITS.sidebar.min}
            aria-valuemax={DASHBOARD_PANEL_LIMITS.sidebar.max}
            aria-valuenow={normalizedSidebarWidth}
            disabled={activeDrawer !== null || blocked}
            onPointerDown={startResize("sidebar", normalizedSidebarWidth, onSidebarWidthChange)}
            onKeyDown={resizeFromKeyboard("sidebar", normalizedSidebarWidth, onSidebarWidthChange)}
          />
        )}

        <section
          className="tw-shell__center"
          inert={activeDrawer !== null}
        >
          <header className="tw-shell__header">{header}</header>
          <main className="tw-shell__workspace">{workspace}</main>
        </section>

        {onInspectorWidthChange && inspectorOpen && (
          <button
            className="tw-shell__resize-handle tw-shell__resize-handle--inspector"
            type="button"
            role="separator"
            aria-label="Resize workspace inspector"
            aria-controls="workspace-inspector"
            aria-orientation="vertical"
            aria-valuemin={DASHBOARD_PANEL_LIMITS.inspector.min}
            aria-valuemax={DASHBOARD_PANEL_LIMITS.inspector.max}
            aria-valuenow={normalizedInspectorWidth}
            disabled={activeDrawer !== null || blocked}
            onPointerDown={startResize("inspector", normalizedInspectorWidth, onInspectorWidthChange)}
            onKeyDown={resizeFromKeyboard("inspector", normalizedInspectorWidth, onInspectorWidthChange)}
          />
        )}

        <aside
          ref={inspectorRef}
          id="workspace-inspector"
          className="tw-shell__inspector"
          aria-label="Workspace inspector"
          aria-modal={activeDrawer === "inspector" ? true : undefined}
          role={activeDrawer === "inspector" ? "dialog" : undefined}
          tabIndex={activeDrawer === "inspector" ? -1 : undefined}
          inert={activeDrawer === "sidebar"}
        >
          {inspector}
        </aside>

        {drawerOpen && (
          <button
            className="tw-shell__drawer-backdrop"
            type="button"
            aria-label="Close open panel"
            onClick={onDismissDrawers}
          />
        )}
      </div>

      {overlays}
    </div>
  );
}
