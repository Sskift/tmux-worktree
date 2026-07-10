import type { CSSProperties, ReactNode } from "react";
import "./DashboardShell.css";

type ShellStyle = CSSProperties & {
  "--tw-sidebar-width"?: string;
  "--tw-inspector-width"?: string;
};

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
  blocked?: boolean;
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
  blocked = false,
  onDismissDrawers,
}: DashboardShellProps) {
  const style: ShellStyle = {
    "--tw-sidebar-width": `${Math.max(240, Math.min(360, sidebarWidth))}px`,
    "--tw-inspector-width": `${Math.max(360, Math.min(480, inspectorWidth))}px`,
  };
  const drawerOpen = sidebarOpen || inspectorOpen;

  return (
    <div
      className="tw-shell"
      data-sidebar-open={sidebarOpen}
      data-inspector-open={inspectorOpen}
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
        <aside className="tw-shell__sidebar" aria-label="Dashboard navigation">
          {sidebar}
        </aside>

        <section className="tw-shell__center">
          <header className="tw-shell__header">{header}</header>
          <main className="tw-shell__workspace">{workspace}</main>
        </section>

        <aside className="tw-shell__inspector" aria-label="Workspace inspector">
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
