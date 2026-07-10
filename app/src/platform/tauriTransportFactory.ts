import type {
  BackendEventHandler,
  BackendUnlisten,
  DashboardTransport,
  DashboardWindow,
} from "./types";

export interface RawDashboardWindow {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  innerSize(): Promise<{ width: number; height: number }>;
  outerPosition(): Promise<{ x: number; y: number }>;
  scaleFactor(): Promise<number>;
  onResized(handler: () => void): Promise<BackendUnlisten>;
  onMoved(handler: () => void): Promise<BackendUnlisten>;
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
  dependencies: TauriTransportDependencies,
): DashboardWindow {
  const window = dependencies.currentWindow();
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
    setLogicalSize: (width, height) =>
      dependencies.setLogicalSize(width, height),
    onResized: (handler) => window.onResized(handler),
    onMoved: (handler) => window.onMoved(handler),
  };
}

export function createTauriTransport(
  dependencies: TauriTransportDependencies,
): DashboardTransport {
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
    currentWindow: () => createWindowAdapter(dependencies),
  };
}
