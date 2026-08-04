import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardWindow } from "../src/platform/types.ts";
import {
  createWindowCaptureCoordinator,
  readWindowCapture,
  windowLayoutFromCapture,
  type WindowCaptureResult,
} from "../src/dashboard/windowCaptureCoordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class ScriptedWindow implements DashboardWindow {
  readonly fullscreenReads: ReturnType<typeof deferred<boolean>>[] = [];
  readonly maximizedReads: ReturnType<typeof deferred<boolean>>[] = [];
  readonly sizeReads: ReturnType<typeof deferred<{ width: number; height: number }>>[] = [];
  readonly positionReads: ReturnType<typeof deferred<{ x: number; y: number }>>[] = [];
  readonly factorReads: ReturnType<typeof deferred<number>>[] = [];
  readonly resizedRegistration = deferred<() => void>();
  readonly movedRegistration = deferred<() => void>();
  resizedHandler: (() => void) | null = null;
  movedHandler: (() => void) | null = null;
  throwResizedRegistration = false;
  throwMovedRegistration = false;

  isFullscreen(): Promise<boolean> {
    const read = deferred<boolean>();
    this.fullscreenReads.push(read);
    return read.promise;
  }

  isMaximized(): Promise<boolean> {
    const read = deferred<boolean>();
    this.maximizedReads.push(read);
    return read.promise;
  }

  innerSize(): Promise<{ width: number; height: number }> {
    const read = deferred<{ width: number; height: number }>();
    this.sizeReads.push(read);
    return read.promise;
  }

  outerPosition(): Promise<{ x: number; y: number }> {
    const read = deferred<{ x: number; y: number }>();
    this.positionReads.push(read);
    return read.promise;
  }

  scaleFactor(): Promise<number> {
    const read = deferred<number>();
    this.factorReads.push(read);
    return read.promise;
  }

  async setLogicalSize(): Promise<void> {}

  onResized(handler: () => void): Promise<() => void> {
    this.resizedHandler = handler;
    if (this.throwResizedRegistration) throw new Error("resize registration failed");
    return this.resizedRegistration.promise;
  }

  onMoved(handler: () => void): Promise<() => void> {
    this.movedHandler = handler;
    if (this.throwMovedRegistration) throw new Error("move registration failed");
    return this.movedRegistration.promise;
  }
}

function manualScheduler() {
  const tasks: Array<{ callback: () => void; cancelled: boolean }> = [];
  return {
    schedule(callback: () => void, delayMs: number) {
      assert.equal(delayMs, 150);
      const task = { callback, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    tasks,
  };
}

function startHarness(target = new ScriptedWindow()) {
  const published: WindowCaptureResult[] = [];
  const scheduler = manualScheduler();
  const coordinator = createWindowCaptureCoordinator({
    debounceMs: 150,
    publish: (result) => published.push(result),
    schedule: scheduler.schedule,
    target,
  });
  coordinator.start();
  return { coordinator, published, scheduler, target };
}

function resolveExpanded(
  target: ScriptedWindow,
  index: number,
  fullscreen: boolean,
  maximized: boolean,
): void {
  target.fullscreenReads[index].resolve(fullscreen);
  target.maximizedReads[index].resolve(maximized);
}

function resolveGeometry(
  target: ScriptedWindow,
  index: number,
  {
    factor = 2,
    height = 1_200,
    width = 2_000,
    x = 200,
    y = 100,
  }: {
    factor?: number;
    height?: number;
    width?: number;
    x?: number;
    y?: number;
  } = {},
): void {
  target.sizeReads[index].resolve({ height, width });
  target.positionReads[index].resolve({ x, y });
  target.factorReads[index].resolve(factor);
}

test("newer capture wins when captures complete in reverse order", async () => {
  const { coordinator, published, scheduler, target } = startHarness();
  resolveExpanded(target, 0, false, false);
  await flushPromises();
  assert.equal(target.sizeReads.length, 1);

  target.resizedHandler?.();
  assert.equal(scheduler.tasks.length, 1);
  scheduler.tasks[0].callback();
  assert.equal(target.fullscreenReads.length, 2);
  resolveExpanded(target, 1, false, false);
  await flushPromises();
  resolveGeometry(target, 1, { height: 900, width: 1_440, x: 40, y: 20 });
  await flushPromises();
  assert.equal(target.fullscreenReads.length, 3);
  resolveExpanded(target, 2, false, false);
  await flushPromises();

  assert.deepEqual(published, [{
    layout: { height: 450, maximized: false, width: 720, x: 20, y: 10 },
    mode: "normal",
  }]);

  resolveGeometry(target, 0, { height: 1_200, width: 2_000, x: 200, y: 100 });
  await flushPromises();
  assert.equal(published.length, 1);
  coordinator.stop();
});

test("an event fences an in-flight capture before its debounce expires", async () => {
  const { coordinator, published, scheduler, target } = startHarness();
  resolveExpanded(target, 0, false, false);
  await flushPromises();
  target.movedHandler?.();
  assert.equal(scheduler.tasks.length, 1);
  resolveGeometry(target, 0);
  await flushPromises();
  assert.deepEqual(published, []);
  assert.equal(target.fullscreenReads.length, 1);
  coordinator.stop();
});

test("bursts reset debounce and cancelled callbacks remain inert", () => {
  const { coordinator, scheduler, target } = startHarness();
  target.resizedHandler?.();
  target.movedHandler?.();
  target.resizedHandler?.();
  assert.equal(scheduler.tasks.length, 3);
  assert.deepEqual(scheduler.tasks.map((task) => task.cancelled), [true, true, false]);

  scheduler.tasks[0].callback();
  scheduler.tasks[1].callback();
  assert.equal(target.fullscreenReads.length, 1);
  scheduler.tasks[2].callback();
  assert.equal(target.fullscreenReads.length, 2);
  coordinator.stop();
});

test("a synchronous scheduler callback follows one active capture path", async () => {
  const target = new ScriptedWindow();
  let cancelCount = 0;
  const published: WindowCaptureResult[] = [];
  const coordinator = createWindowCaptureCoordinator({
    debounceMs: 150,
    publish: (result) => published.push(result),
    schedule: (callback) => {
      callback();
      return () => {
        cancelCount += 1;
      };
    },
    target,
  });
  coordinator.start();
  target.resizedHandler?.();
  assert.equal(target.fullscreenReads.length, 1);
  await flushPromises();
  assert.equal(target.fullscreenReads.length, 2);
  resolveExpanded(target, 1, false, true);
  await flushPromises();
  assert.deepEqual(published, [{ mode: "maximized" }]);
  coordinator.stop();
  assert.equal(cancelCount, 0);
});

test("stopping before a synchronous scheduler microtask fences and cancels it", async () => {
  const target = new ScriptedWindow();
  let cancelCount = 0;
  const coordinator = createWindowCaptureCoordinator({
    debounceMs: 150,
    publish: () => assert.fail("stopped synchronous capture must not publish"),
    schedule: (callback) => {
      callback();
      return () => {
        cancelCount += 1;
      };
    },
    target,
  });
  coordinator.start();
  target.resizedHandler?.();
  coordinator.stop();
  await flushPromises();
  assert.equal(target.fullscreenReads.length, 1);
  assert.equal(cancelCount, 1);
});

test("normal capture rechecks expanded mode and requests a fresh baseline", async () => {
  const { coordinator, published, target } = startHarness();
  resolveExpanded(target, 0, false, false);
  await flushPromises();
  resolveGeometry(target, 0);
  await flushPromises();
  resolveExpanded(target, 1, true, false);
  await flushPromises();

  assert.deepEqual(published, []);
  assert.equal(target.fullscreenReads.length, 3);
  resolveExpanded(target, 2, true, false);
  await flushPromises();
  assert.deepEqual(published, [{ mode: "fullscreen" }]);
  coordinator.stop();
});

test("invalid normal geometry and expanded read failures publish nothing", async () => {
  const invalidCases = [
    { factor: 0 },
    { factor: Number.NaN },
    { width: 0 },
    { height: Number.POSITIVE_INFINITY },
    { x: Number.NaN },
    { y: Number.NEGATIVE_INFINITY },
  ];
  for (const invalid of invalidCases) {
    const { coordinator, published, target } = startHarness();
    resolveExpanded(target, 0, false, false);
    await flushPromises();
    resolveGeometry(target, 0, invalid);
    await flushPromises();
    assert.deepEqual(published, []);
    assert.equal(target.fullscreenReads.length, 1);
    coordinator.stop();
  }

  for (const failedMethod of ["fullscreen", "maximized"] as const) {
    const { coordinator, published, target } = startHarness();
    if (failedMethod === "fullscreen") {
      target.fullscreenReads[0].reject(new Error("fullscreen failed"));
      target.maximizedReads[0].resolve(false);
    } else {
      target.fullscreenReads[0].resolve(false);
      target.maximizedReads[0].reject(new Error("maximized failed"));
    }
    await flushPromises();
    assert.deepEqual(published, []);
    assert.equal(target.sizeReads.length, 0);
    coordinator.stop();
  }
});

test("listener settlement preserves an event trailing timer and coalesces into one capture", async () => {
  const { coordinator, scheduler, target } = startHarness();
  target.resizedHandler?.();
  assert.equal(scheduler.tasks.length, 1);
  const eventTimer = scheduler.tasks[0];

  target.resizedRegistration.resolve(() => {});
  target.movedRegistration.reject(new Error("move listener rejected"));
  await flushPromises();
  assert.equal(scheduler.tasks.length, 1);
  assert.strictEqual(scheduler.tasks[0], eventTimer);
  assert.equal(eventTimer.cancelled, false);
  assert.equal(target.fullscreenReads.length, 1);

  eventTimer.callback();
  assert.equal(target.fullscreenReads.length, 2);
  coordinator.stop();
});

test("listener throws and rejects are contained behind one trailing capture", async () => {
  const target = new ScriptedWindow();
  target.throwMovedRegistration = true;
  const { coordinator, scheduler } = startHarness(target);
  assert.equal(target.fullscreenReads.length, 1);
  assert.equal(scheduler.tasks.length, 1);

  target.resizedRegistration.reject(new Error("resize listener rejected"));
  await flushPromises();
  assert.equal(target.fullscreenReads.length, 1);
  assert.equal(scheduler.tasks.length, 1);
  scheduler.tasks[0].callback();
  assert.equal(target.fullscreenReads.length, 2);
  coordinator.stop();
});

test("successful listener settlements coalesce without immediate reads", async () => {
  const successful = startHarness();
  let resizedUnlistenCount = 0;
  let movedUnlistenCount = 0;
  successful.target.resizedRegistration.resolve(() => {
    resizedUnlistenCount += 1;
  });
  successful.target.movedRegistration.resolve(() => {
    movedUnlistenCount += 1;
  });
  await flushPromises();
  assert.equal(successful.target.fullscreenReads.length, 1);
  assert.equal(successful.scheduler.tasks.length, 1);
  successful.scheduler.tasks[0].callback();
  assert.equal(successful.target.fullscreenReads.length, 2);
  successful.coordinator.stop();
  assert.equal(resizedUnlistenCount, 1);
  assert.equal(movedUnlistenCount, 1);
});

test("scheduler throws fall back to one fenced capture without escaping", async () => {
  const target = new ScriptedWindow();
  target.throwMovedRegistration = true;
  let scheduleCalls = 0;
  const coordinator = createWindowCaptureCoordinator({
    debounceMs: 150,
    publish: () => {},
    schedule: () => {
      scheduleCalls += 1;
      throw new Error("scheduler failed");
    },
    target,
  });
  assert.doesNotThrow(() => coordinator.start());
  assert.equal(scheduleCalls, 1);
  assert.equal(target.fullscreenReads.length, 2);
  target.resizedRegistration.reject(new Error("resize listener rejected"));
  await flushPromises();
  assert.equal(scheduleCalls, 2);
  assert.equal(target.fullscreenReads.length, 3);
  coordinator.stop();
});

test("late listener resolution after stop unlistens exactly once", async () => {
  const { coordinator, scheduler, target } = startHarness();
  let resizedUnlisten = 0;
  let movedUnlisten = 0;
  coordinator.stop();
  coordinator.stop();
  target.resizedHandler?.();
  target.movedHandler?.();
  assert.equal(scheduler.tasks.length, 0);
  target.resizedRegistration.resolve(() => {
    resizedUnlisten += 1;
  });
  target.movedRegistration.resolve(() => {
    movedUnlisten += 1;
  });
  await flushPromises();
  assert.equal(resizedUnlisten, 1);
  assert.equal(movedUnlisten, 1);
  assert.equal(target.fullscreenReads.length, 1);
});

test("stopping the old backend fences its reads before replacement starts", async () => {
  const oldHarness = startHarness();
  oldHarness.coordinator.stop();
  const replacement = startHarness();

  resolveExpanded(replacement.target, 0, false, true);
  await flushPromises();
  resolveExpanded(oldHarness.target, 0, true, false);
  await flushPromises();

  assert.deepEqual(replacement.published, [{ mode: "maximized" }]);
  assert.deepEqual(oldHarness.published, []);
  replacement.coordinator.stop();
});

test("later normal requests fence older expanded-mode results", async () => {
  for (const oldMode of ["fullscreen", "maximized"] as const) {
    const { coordinator, published, scheduler, target } = startHarness();
    target.resizedHandler?.();
    scheduler.tasks[0].callback();
    resolveExpanded(target, 1, false, false);
    await flushPromises();
    resolveGeometry(target, 0, { height: 800, width: 1_000, x: 24, y: 12 });
    await flushPromises();
    resolveExpanded(target, 2, false, false);
    await flushPromises();
    resolveExpanded(
      target,
      0,
      oldMode === "fullscreen",
      oldMode === "maximized",
    );
    await flushPromises();
    assert.deepEqual(published, [{
      layout: { height: 400, maximized: false, width: 500, x: 12, y: 6 },
      mode: "normal",
    }]);
    coordinator.stop();
  }
});

test("direct window reads return every outcome without throwing", async () => {
  {
    const target = new ScriptedWindow();
    const read = readWindowCapture(target, new AbortController().signal);
    resolveExpanded(target, 0, false, true);
    assert.deepEqual(await read, {
      kind: "captured",
      result: { mode: "maximized" },
    });
  }
  {
    const target = new ScriptedWindow();
    const read = readWindowCapture(target, new AbortController().signal);
    resolveExpanded(target, 0, false, false);
    await flushPromises();
    resolveGeometry(target, 0);
    await flushPromises();
    resolveExpanded(target, 1, true, false);
    assert.deepEqual(await read, { kind: "changed" });
  }
  {
    const target = new ScriptedWindow();
    const read = readWindowCapture(target, new AbortController().signal);
    resolveExpanded(target, 0, false, false);
    await flushPromises();
    resolveGeometry(target, 0, { factor: 0 });
    assert.deepEqual(await read, { kind: "unavailable" });
  }
  {
    const target = new ScriptedWindow();
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await readWindowCapture(target, controller.signal), {
      kind: "cancelled",
    });
    assert.equal(target.fullscreenReads.length, 0);
  }
});

test("direct window reads check cancellation after every awaited geometry value", async () => {
  for (const stage of [
    "expanded-fullscreen",
    "expanded-maximized",
    "size",
    "position",
    "factor",
    "confirmed-fullscreen",
    "confirmed-maximized",
  ] as const) {
    const target = new ScriptedWindow();
    const controller = new AbortController();
    const read = readWindowCapture(target, controller.signal);
    if (stage === "expanded-fullscreen") {
      target.fullscreenReads[0].resolve(false);
      controller.abort();
    } else {
      target.fullscreenReads[0].resolve(false);
      await flushPromises();
      target.maximizedReads[0].resolve(false);
      if (stage === "expanded-maximized") {
        controller.abort();
      } else {
        await flushPromises();
        target.sizeReads[0].resolve({ width: 2_000, height: 1_200 });
        if (stage === "size") {
          controller.abort();
        } else {
          await flushPromises();
          target.positionReads[0].resolve({ x: 200, y: 100 });
          if (stage === "position") {
            controller.abort();
          } else {
            await flushPromises();
            target.factorReads[0].resolve(2);
            if (stage === "factor") {
              controller.abort();
            } else {
              await flushPromises();
              target.fullscreenReads[1].resolve(false);
              if (stage === "confirmed-fullscreen") {
                controller.abort();
              } else {
                await flushPromises();
                target.maximizedReads[1].resolve(false);
                controller.abort();
              }
            }
          }
        }
      }
    }
    assert.deepEqual(await read, { kind: "cancelled" }, stage);
  }
});

test("capture results preserve fullscreen and maximized baseline semantics", () => {
  const previous = { height: 800, maximized: false, width: 1_200, x: -20, y: 30 };
  assert.strictEqual(windowLayoutFromCapture(previous, { mode: "fullscreen" }), previous);
  const previousMaximized = { ...previous, maximized: true };
  assert.strictEqual(
    windowLayoutFromCapture(previousMaximized, { mode: "fullscreen" }),
    previousMaximized,
  );
  assert.deepEqual(windowLayoutFromCapture(null, { mode: "fullscreen" }), {
    height: 900,
    maximized: false,
    width: 1_440,
    x: 0,
    y: 0,
  });
  assert.deepEqual(windowLayoutFromCapture(previous, { mode: "maximized" }), {
    ...previous,
    maximized: true,
  });
  assert.deepEqual(windowLayoutFromCapture(null, { mode: "maximized" }), {
    height: 900,
    maximized: true,
    width: 1_440,
    x: 0,
    y: 0,
  });
  const normal = { height: 600, maximized: false, width: 800, x: 10, y: 20 };
  assert.strictEqual(
    windowLayoutFromCapture(previous, { layout: normal, mode: "normal" }),
    normal,
  );
});
