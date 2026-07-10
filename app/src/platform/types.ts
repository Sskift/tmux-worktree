export type BackendUnlisten = () => void;

export type BackendEventHandler<T> = (payload: T) => void | Promise<void>;

export type PhysicalPoint = {
  x: number;
  y: number;
};

export type PhysicalDimensions = {
  width: number;
  height: number;
};

export interface DashboardWindow {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  /** Current inner size in physical pixels, matching the Tauri window API. */
  innerSize(): Promise<PhysicalDimensions>;
  /** Current outer position in physical pixels, matching the Tauri window API. */
  outerPosition(): Promise<PhysicalPoint>;
  scaleFactor(): Promise<number>;
  setLogicalSize(width: number, height: number): Promise<void>;
  onResized(handler: () => void): Promise<BackendUnlisten>;
  onMoved(handler: () => void): Promise<BackendUnlisten>;
}

export type DirectoryDialogOptions = {
  title: string;
};

export type ConfirmDialogOptions = {
  message: string;
  title?: string;
};

export interface DashboardTransport {
  invoke<T>(command: string, args?: unknown): Promise<T>;
  listen<T>(event: string, handler: BackendEventHandler<T>): Promise<BackendUnlisten>;
  assetUrl(path: string): string;
  selectDirectory(options: DirectoryDialogOptions): Promise<string | null>;
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  currentWindow(): DashboardWindow;
}

export type PtyOpenArgs = {
  id: string;
  cmd: string;
  args: string[];
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
};

export type PtyDataEvent = {
  id: string;
  data: string;
};

export type PtyExitEvent = {
  id: string;
  code: number;
};

export type PtyHandlers = {
  onData(event: PtyDataEvent): void;
  onExit(event: PtyExitEvent): void | Promise<void>;
};

export interface PtyConnection {
  readonly id: string;
  readonly active: boolean;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
