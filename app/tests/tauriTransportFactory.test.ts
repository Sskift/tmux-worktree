import assert from "node:assert/strict";
import test from "node:test";
import {
  createTauriTransport,
  type RawDashboardWindow,
  type RawDashboardWindowCloseLifecycle,
  type TauriTransportDependencies,
} from "../src/platform/tauriTransportFactory.ts";
import { createDashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { NativeDashboardCloseRequest } from "../src/platform/windowCloseBridge.ts";

class RawWindowStub implements RawDashboardWindow {
  resized = new Set<() => void>();
  moved = new Set<() => void>();
  closeLifecycle?: RawDashboardWindowCloseLifecycle;

  async isFullscreen() { return false; }
  async isMaximized() { return true; }
  async innerSize() { return { width: 2880, height: 1800 }; }
  async outerPosition() { return { x: 120, y: 80 }; }
  async scaleFactor() { return 2; }
  async onResized(handler: () => void) {
    this.resized.add(handler);
    return () => this.resized.delete(handler);
  }
  async onMoved(handler: () => void) {
    this.moved.add(handler);
    return () => this.moved.delete(handler);
  }
}

class TauriDependenciesStub implements TauriTransportDependencies {
  calls: Array<{ command: string; args?: unknown }> = [];
  responses = new Map<string, unknown>();
  envelopeHandlers = new Map<string, (message: { payload: unknown }) => void>();
  unlistened: string[] = [];
  directoryResult: string | string[] | null = null;
  confirmCalls: Array<{ message: string; title?: string }> = [];
  logicalSizes: Array<{ width: number; height: number }> = [];
  window = new RawWindowStub();
  currentWindowCalls = 0;

  async invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    const result = this.responses.get(command);
    if (result instanceof Error) throw result;
    return result as T;
  }

  async listen<T>(
    event: string,
    handler: (message: { payload: T }) => void,
  ) {
    this.envelopeHandlers.set(
      event,
      handler as (message: { payload: unknown }) => void,
    );
    return () => {
      this.envelopeHandlers.delete(event);
      this.unlistened.push(event);
    };
  }

  assetUrl(path: string): string {
    return `asset://${path}`;
  }

  async selectDirectory(): Promise<string | string[] | null> {
    return this.directoryResult;
  }

  async confirm(message: string, title?: string): Promise<boolean> {
    this.confirmCalls.push({ message, title });
    return true;
  }

  currentWindow(): RawDashboardWindow {
    this.currentWindowCalls += 1;
    return this.window;
  }

  async setLogicalSize(width: number, height: number): Promise<void> {
    this.logicalSizes.push({ width, height });
  }
}

test("Tauri transport forwards invoke results, payloads, errors, and event unsubscribe", async () => {
  const dependencies = new TauriDependenciesStub();
  dependencies.responses.set("ready", { ok: true });
  dependencies.responses.set("failed", new Error("transport failed"));
  const transport = createTauriTransport(dependencies);

  assert.deepEqual(await transport.invoke("ready", { id: 1 }), { ok: true });
  await assert.rejects(transport.invoke("failed"), /transport failed/);
  assert.deepEqual(dependencies.calls, [
    { command: "ready", args: { id: 1 } },
    { command: "failed", args: undefined },
  ]);

  const payloads: string[] = [];
  const unlisten = await transport.listen<{ value: string }>("status", (payload) => {
    payloads.push(payload.value);
  });
  dependencies.envelopeHandlers.get("status")?.({ payload: { value: "online" } });
  assert.deepEqual(payloads, ["online"]);

  unlisten();
  assert.deepEqual(dependencies.unlistened, ["status"]);
  assert.equal(dependencies.envelopeHandlers.has("status"), false);
});

test("Tauri transport normalizes dialogs, assets, and physical window values", async () => {
  const dependencies = new TauriDependenciesStub();
  const transport = createTauriTransport(dependencies);

  dependencies.directoryResult = "/repo/dashboard";
  assert.equal(
    await transport.selectDirectory({ title: "Choose repository" }),
    "/repo/dashboard",
  );
  dependencies.directoryResult = ["/repo/one", "/repo/two"];
  assert.equal(await transport.selectDirectory({ title: "Choose one" }), null);
  assert.equal(transport.assetUrl("/tmp/icon.png"), "asset:///tmp/icon.png");
  assert.equal(
    await transport.confirm({ title: "Delete", message: "Delete host?" }),
    true,
  );
  assert.deepEqual(dependencies.confirmCalls, [
    { title: "Delete", message: "Delete host?" },
  ]);

  const window = transport.currentWindow();
  assert.strictEqual(transport.currentWindow(), window);
  assert.equal(dependencies.currentWindowCalls, 1);
  assert.equal(await window.isFullscreen(), false);
  assert.equal(await window.isMaximized(), true);
  assert.deepEqual(await window.innerSize(), { width: 2880, height: 1800 });
  assert.deepEqual(await window.outerPosition(), { x: 120, y: 80 });
  assert.equal(await window.scaleFactor(), 2);
  await window.setLogicalSize(1440, 900);
  assert.deepEqual(dependencies.logicalSizes, [{ width: 1440, height: 900 }]);

  const stopResize = await window.onResized(() => {});
  const stopMove = await window.onMoved(() => {});
  assert.equal(dependencies.window.resized.size, 1);
  assert.equal(dependencies.window.moved.size, 1);
  stopResize();
  stopMove();
  assert.equal(dependencies.window.resized.size, 0);
  assert.equal(dependencies.window.moved.size, 0);
  assert.equal("closeLifecycle" in transport, false);
  assert.equal("closeLifecycle" in createDashboardBackend(transport).window, false);
});

test("Tauri transport eagerly registers one atomic close capability", async () => {
  const dependencies = new TauriDependenciesStub();
  const events: string[] = [];
  let closeHandler: ((event: NativeDashboardCloseRequest) => void) | null = null;
  let registrationCount = 0;
  let destroyCount = 0;
  dependencies.window.closeLifecycle = {
    onCloseRequested(handler) {
      registrationCount += 1;
      closeHandler = handler;
      return Promise.resolve(() => {});
    },
    async destroy() {
      destroyCount += 1;
    },
  };

  const transport = createTauriTransport(dependencies);
  assert.equal(dependencies.currentWindowCalls, 1);
  assert.equal(registrationCount, 1);
  assert.ok(transport.closeLifecycle);
  const backend = createDashboardBackend(transport);
  assert.strictEqual(backend.window.closeLifecycle, transport.closeLifecycle);
  const unbind = transport.closeLifecycle.bind((signal) => {
    events.push(`handler:${signal.aborted}`);
  });
  assert.ok(closeHandler);
  const emitClose = closeHandler as unknown as (
    event: NativeDashboardCloseRequest,
  ) => void;
  emitClose({
    preventDefault() {
      events.push("prevent");
    },
  });
  assert.deepEqual(events, ["prevent", "handler:false"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(destroyCount, 1);
  unbind();
});
