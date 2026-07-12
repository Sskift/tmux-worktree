import type {
  BackendEventHandler,
  BackendUnlisten,
  DashboardTransport,
  DashboardWindow,
} from "./types";
import {
  createWindowCloseBridge,
  type NativeDashboardCloseRequest,
} from "./windowCloseBridge";

export interface RawDashboardWindowCloseLifecycle {
  onCloseRequested(
    handler: (event: NativeDashboardCloseRequest) => void,
  ): Promise<BackendUnlisten>;
  destroy(): Promise<void>;
}

export interface RawDashboardWindow {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  innerSize(): Promise<{ width: number; height: number }>;
  outerPosition(): Promise<{ x: number; y: number }>;
  scaleFactor(): Promise<number>;
  onResized(handler: () => void): Promise<BackendUnlisten>;
  onMoved(handler: () => void): Promise<BackendUnlisten>;
  closeLifecycle?: RawDashboardWindowCloseLifecycle;
}

export interface TauriTransportDependencies {
  invoke<T>(command: string, args?: unknown): Promise<T>;
  listen<T>(
    event: string,
    handler: (message: { payload: T }) => void,
  ): Promise<BackendUnlisten>;
  assetUrl(path: string): string;
  selectDirectory(title: string): Promise<string | string[] | null>;
  confirm(message: string, title?: string): Promise<boolean>;
  currentWindow(): RawDashboardWindow;
  setLogicalSize(width: number, height: number): Promise<void>;
}

function createWindowAdapter(
  window: RawDashboardWindow,
  setLogicalSize: TauriTransportDependencies["setLogicalSize"],
): DashboardWindow {
  return {
    isFullscreen: () => window.isFullscreen(),
    isMaximized: () => window.isMaximized(),
    innerSize: async () => {
      const value = await window.innerSize();
      return { width: value.width, height: value.height };
    },
    outerPosition: async () => {
      const value = await window.outerPosition();
      return { x: value.x, y: value.y };
    },
    scaleFactor: () => window.scaleFactor(),
    setLogicalSize: (width, height) => setLogicalSize(width, height),
    onResized: (handler) => window.onResized(handler),
    onMoved: (handler) => window.onMoved(handler),
  };
}

export function createTauriTransport(
  dependencies: TauriTransportDependencies,
): DashboardTransport {
  const rawWindow = dependencies.currentWindow();
  const windowAdapter = createWindowAdapter(
    rawWindow,
    (width, height) => dependencies.setLogicalSize(width, height),
  );
  const rawCloseLifecycle = rawWindow.closeLifecycle;
  const closeLifecycle = rawCloseLifecycle
    ? createWindowCloseBridge({
        onCloseRequested: (handler) =>
          rawCloseLifecycle.onCloseRequested(handler),
        destroy: () => rawCloseLifecycle.destroy(),
      })
    : null;
  return {
    invoke: (command, args) => dependencies.invoke(command, args),
    listen: async <T>(event: string, handler: BackendEventHandler<T>) =>
      dependencies.listen<T>(event, (message) => {
        try {
          void Promise.resolve(handler(message.payload)).catch(() => {});
        } catch {
          // Event consumer failures must not become unhandled adapter callbacks.
        }
      }),
    assetUrl: (path) => dependencies.assetUrl(path),
    selectDirectory: async ({ title }) => {
      const result = await dependencies.selectDirectory(title);
      return typeof result === "string" ? result : null;
    },
    confirm: ({ message, title }) => dependencies.confirm(message, title),
    currentWindow: () => windowAdapter,
    ...(closeLifecycle ? { closeLifecycle } : {}),
  };
}
