import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { createDashboardBackend } from "./dashboardBackend";
import { createRelayV2ManagementAdapter } from "./relayV2ManagementAdapter";
import { createTauriTransport } from "./tauriTransportFactory";

const currentWindow = getCurrentWindow();

export const tauriTransport = createTauriTransport({
  invoke: (command, args) =>
    invoke(command, args as Record<string, unknown> | undefined),
  listen: (event, handler) => listen(event, handler),
  assetUrl: convertFileSrc,
  selectDirectory: (title) => open({ directory: true, multiple: false, title }),
  confirm: (message, title) => confirm(message, title ? { title } : undefined),
  currentWindow: () => ({
    isFullscreen: () => currentWindow.isFullscreen(),
    isMaximized: () => currentWindow.isMaximized(),
    innerSize: () => currentWindow.innerSize(),
    outerPosition: () => currentWindow.outerPosition(),
    scaleFactor: () => currentWindow.scaleFactor(),
    onResized: (handler) => currentWindow.onResized(handler),
    onMoved: (handler) => currentWindow.onMoved(handler),
    closeLifecycle: {
      onCloseRequested: (handler) => currentWindow.onCloseRequested(handler),
      destroy: () => currentWindow.destroy(),
    },
  }),
  setLogicalSize: (width, height) =>
    currentWindow.setSize(new LogicalSize(width, height)),
});

export const tauriDashboardBackend = createDashboardBackend(tauriTransport, {
  relayV2: createRelayV2ManagementAdapter(
    (command, args) => tauriTransport.invoke(command, args),
  ),
});
