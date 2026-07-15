import {
  createDashboardBackend,
  type DashboardBackend,
  type MobileRelayV2ProductAdapter,
} from "./dashboardBackend.ts";
import type {
  BackendEventHandler,
  ConfirmDialogOptions,
  DashboardTransport,
  DashboardWindow,
  DirectoryDialogOptions,
} from "./types";

export type FakeBackendCall = {
  command: string;
  args?: unknown;
};

export type FakeBackendHandler = (args?: unknown) => unknown | Promise<unknown>;

export class FakeWindow implements DashboardWindow {
  fullscreen = false;
  maximized = false;
  width = 1440;
  height = 900;
  x = 0;
  y = 0;
  factor = 1;
  private readonly resizedHandlers = new Set<() => void>();
  private readonly movedHandlers = new Set<() => void>();

  async isFullscreen() { return this.fullscreen; }
  async isMaximized() { return this.maximized; }
  async innerSize() { return { width: this.width, height: this.height }; }
  async outerPosition() { return { x: this.x, y: this.y }; }
  async scaleFactor() { return this.factor; }
  async setLogicalSize(width: number, height: number) {
    this.width = width * this.factor;
    this.height = height * this.factor;
    this.emitResized();
  }
  async onResized(handler: () => void) {
    this.resizedHandlers.add(handler);
    return () => this.resizedHandlers.delete(handler);
  }
  async onMoved(handler: () => void) {
    this.movedHandlers.add(handler);
    return () => this.movedHandlers.delete(handler);
  }
  emitResized() {
    for (const handler of this.resizedHandlers) handler();
  }
  emitMoved() {
    for (const handler of this.movedHandlers) handler();
  }
  listenerCount(kind: "resized" | "moved") {
    return kind === "resized" ? this.resizedHandlers.size : this.movedHandlers.size;
  }
}

export class FakeDashboardTransport implements DashboardTransport {
  readonly calls: FakeBackendCall[] = [];
  readonly handlers = new Map<string, FakeBackendHandler>();
  readonly window = new FakeWindow();
  selectedDirectory: string | null = null;
  confirmationResult = true;
  private readonly listeners = new Map<string, Set<BackendEventHandler<unknown>>>();

  constructor(handlers?: Record<string, FakeBackendHandler>) {
    for (const [command, handler] of Object.entries(handlers ?? {})) {
      this.handlers.set(command, handler);
    }
  }

  async invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    const handler = this.handlers.get(command);
    if (!handler) throw new Error(`fake backend command not implemented: ${command}`);
    return await handler(args) as T;
  }

  async listen<T>(event: string, handler: BackendEventHandler<T>) {
    const set = this.listeners.get(event) ?? new Set<BackendEventHandler<unknown>>();
    set.add(handler as BackendEventHandler<unknown>);
    this.listeners.set(event, set);
    return () => {
      set.delete(handler as BackendEventHandler<unknown>);
      if (set.size === 0) this.listeners.delete(event);
    };
  }

  emit<T>(event: string, payload: T): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        void Promise.resolve(handler(payload)).catch(() => {});
      } catch {
        // Synchronous fake event failures mirror the production adapter boundary.
      }
    }
  }

  async emitAsync<T>(event: string, payload: T): Promise<void> {
    for (const handler of this.listeners.get(event) ?? []) await handler(payload);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  assetUrl(path: string): string {
    return `fake-asset://${encodeURIComponent(path)}`;
  }

  async selectDirectory(_options: DirectoryDialogOptions): Promise<string | null> {
    return this.selectedDirectory;
  }

  async confirm(_options: ConfirmDialogOptions): Promise<boolean> {
    return this.confirmationResult;
  }

  currentWindow(): DashboardWindow {
    return this.window;
  }
}

export function createFakeDashboardBackend(
  handlers?: Record<string, FakeBackendHandler>,
  adapters: { relayV2?: MobileRelayV2ProductAdapter } = {},
): { backend: DashboardBackend; transport: FakeDashboardTransport } {
  const transport = new FakeDashboardTransport(handlers);
  return { backend: createDashboardBackend(transport, adapters), transport };
}
