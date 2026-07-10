import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { createDashboardBackend } from "./dashboardBackend";
import { createTauriTransport } from "./tauriTransportFactory";

export const tauriTransport = createTauriTransport({
  invoke: (command, args) =>
    invoke(command, args as Record<string, unknown> | undefined),
  listen: (event, handler) => listen(event, handler),
  assetUrl: convertFileSrc,
  selectDirectory: (title) => open({ directory: true, multiple: false, title }),
  confirm: (message, title) => confirm(message, title ? { title } : undefined),
  currentWindow: getCurrentWindow,
  setLogicalSize: (width, height) =>
    getCurrentWindow().setSize(new LogicalSize(width, height)),
});

export const tauriDashboardBackend = createDashboardBackend(tauriTransport);
