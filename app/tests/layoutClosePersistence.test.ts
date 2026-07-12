import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardBackend } from "../src/platform/dashboardBackend.ts";
import type { DashboardWindow } from "../src/platform/types.ts";
import type { DashboardLayoutPreferences } from "../src/dashboard/layout/types.ts";
import { flushDashboardLayoutOnClose } from "../src/dashboard/layoutClosePersistence.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class ImmediateWindow implements DashboardWindow {
  fullscreen = [false, false];
  maximized = [false, false];
  width = 2_000;
  height = 1_200;
  x = 200;
  y = 100;
  factor = 2;
  reads: string[] = [];
  failFullscreen = false;

  async isFullscreen() {
    this.reads.push("fullscreen");
    if (this.failFullscreen) throw new Error("fullscreen unavailable");
    return this.fullscreen.shift() ?? false;
  }
  async isMaximized() {
    this.reads.push("maximized");
    return this.maximized.shift() ?? false;
  }
  async innerSize() {
    this.reads.push("size");
    return { width: this.width, height: this.height };
  }
  async outerPosition() {
    this.reads.push("position");
    return { x: this.x, y: this.y };
  }
  async scaleFactor() {
    this.reads.push("factor");
    return this.factor;
  }
  async setLogicalSize() {}
  async onResized() { return () => {}; }
  async onMoved() { return () => {}; }
}

function snapshot(): DashboardLayoutPreferences {
  return {
    columnOrder: ["file", "main", "scratch", "editor"],
    sidebarWidth: 300,
    window: {
      width: 1_280,
      height: 800,
      x: -20,
      y: 30,
      maximized: false,
    },
  };
}

function closeHarness(target = new ImmediateWindow()) {
  const backend = {} as DashboardBackend;
  const writes: Array<{
    attempt: number;
    snapshot: DashboardLayoutPreferences;
    signal: AbortSignal;
  }> = [];
  let gate = { attempt: 7, backend, writable: true };
  let cut: { attempt: number; snapshot: DashboardLayoutPreferences } | null = {
    attempt: 7,
    snapshot: snapshot(),
  };
  let active = true;
  let activeCutBackend = backend;
  return {
    backend,
    flush: (signal = new AbortController().signal) =>
      flushDashboardLayoutOnClose({
        backend,
        coordinator: {
          flush: async (attempt, finalSnapshot, flushSignal) => {
            writes.push({ attempt, snapshot: finalSnapshot, signal: flushSignal });
            return "flushed";
          },
        },
        getGate: () => gate,
        getLatestSnapshotCut: () => activeCutBackend === backend ? cut : null,
        isActive: () => active,
        target,
      }, signal),
    setActive(value: boolean) {
      active = value;
    },
    setActiveCutBackend(value: DashboardBackend) {
      activeCutBackend = value;
    },
    setCut(value: typeof cut) {
      cut = value;
    },
    setGate(value: typeof gate) {
      gate = value;
    },
    target,
    writes,
  };
}

test("close normal capture overrides only the final window and flushes once", async () => {
  const harness = closeHarness();
  await harness.flush();
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].attempt, 7);
  assert.deepEqual(harness.writes[0].snapshot.window, {
    width: 1_000,
    height: 600,
    x: 100,
    y: 50,
    maximized: false,
  });
  assert.equal(harness.writes[0].snapshot.sidebarWidth, 300);
});

test("close maximized and fullscreen preserve the last normal rectangle", async () => {
  {
    const target = new ImmediateWindow();
    target.fullscreen = [false];
    target.maximized = [true];
    const harness = closeHarness(target);
    await harness.flush();
    assert.deepEqual(harness.writes[0].snapshot.window, {
      width: 1_280,
      height: 800,
      x: -20,
      y: 30,
      maximized: true,
    });
  }
  {
    const target = new ImmediateWindow();
    target.fullscreen = [true];
    target.maximized = [false];
    const harness = closeHarness(target);
    const previous = snapshot();
    previous.window = { ...previous.window!, maximized: true };
    harness.setCut({ attempt: 7, snapshot: previous });
    await harness.flush();
    assert.deepEqual(harness.writes[0].snapshot.window, {
      width: 1_280,
      height: 800,
      x: -20,
      y: 30,
      maximized: true,
    });
  }
});

test("unavailable and changed captures flush the last known window unchanged", async () => {
  {
    const target = new ImmediateWindow();
    target.failFullscreen = true;
    const harness = closeHarness(target);
    const previous = harness.writes;
    await harness.flush();
    assert.equal(previous.length, 1);
    assert.deepEqual(previous[0].snapshot.window, snapshot().window);
  }
  {
    const target = new ImmediateWindow();
    target.fullscreen = [false, true];
    target.maximized = [false, false];
    const harness = closeHarness(target);
    await harness.flush();
    assert.equal(harness.writes.length, 1);
    assert.deepEqual(harness.writes[0].snapshot.window, snapshot().window);
  }
});

test("abort inactive and authorization mismatches perform zero flushes", async () => {
  {
    const harness = closeHarness();
    const controller = new AbortController();
    controller.abort();
    await harness.flush(controller.signal);
    assert.equal(harness.target.reads.length, 0);
    assert.equal(harness.writes.length, 0);
  }
  {
    const harness = closeHarness();
    harness.setActive(false);
    await harness.flush();
    assert.equal(harness.target.reads.length, 0);
    assert.equal(harness.writes.length, 0);
  }
  for (const mismatch of ["no-cut", "stale-attempt", "owner", "blocked"] as const) {
    const harness = closeHarness();
    if (mismatch === "no-cut") harness.setCut(null);
    if (mismatch === "stale-attempt") {
      harness.setCut({ attempt: 6, snapshot: snapshot() });
    }
    if (mismatch === "owner") {
      harness.setGate({
        attempt: 7,
        backend: {} as DashboardBackend,
        writable: true,
      });
    }
    if (mismatch === "blocked") {
      harness.setGate({ attempt: 7, backend: harness.backend, writable: false });
    }
    await harness.flush();
    assert.ok(harness.target.reads.length > 0, "geometry is read before the latest cut");
    assert.equal(harness.writes.length, 0, mismatch);
  }
});

test("a backend render switch fences an old handler before its geometry settles", async () => {
  const fullscreen = deferred<boolean>();
  const target = new ImmediateWindow();
  target.isFullscreen = async () => {
    target.reads.push("fullscreen");
    return fullscreen.promise;
  };
  const harness = closeHarness(target);
  const pending = harness.flush();
  harness.setActiveCutBackend({} as DashboardBackend);
  fullscreen.resolve(true);
  await pending;
  assert.equal(harness.writes.length, 0);
});
