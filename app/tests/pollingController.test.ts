import assert from "node:assert/strict";
import test from "node:test";
import {
  PollingController,
  type PollingClock,
  type PollingVisibility,
} from "../src/dashboard/hooks/pollingController.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeClock implements PollingClock {
  private nextId = 1;
  private callbacks = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.callbacks.delete(id as number);
  }

  delays(): number[] {
    return [...this.callbacks.values()].map((item) => item.delayMs);
  }

  count(): number {
    return this.callbacks.size;
  }
}

class FakeVisibility implements PollingVisibility {
  hidden = false;
  private handlers = new Set<() => void>();

  isHidden(): boolean {
    return this.hidden;
  }

  subscribe(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const handler of this.handlers) handler();
  }

  count(): number {
    return this.handlers.size;
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("polling never overlaps and schedules the next run after completion", async () => {
  const clock = new FakeClock();
  const visibility = new FakeVisibility();
  const first = deferred<void>();
  let calls = 0;
  const controller = new PollingController({
    clock,
    visibility,
    visibleIntervalMs: 4_000,
    hiddenIntervalMs: 30_000,
    task: () => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve();
    },
  });

  controller.start();
  await flushPromises();
  assert.equal(calls, 1);
  assert.equal(clock.count(), 0);
  controller.trigger();
  assert.equal(calls, 1);

  first.resolve();
  await flushPromises();
  assert.equal(calls, 2);
  await flushPromises();
  assert.deepEqual(clock.delays(), [4_000]);
  controller.stop();
});

test("hidden polling slows down and becoming visible refreshes immediately", async () => {
  const clock = new FakeClock();
  const visibility = new FakeVisibility();
  let calls = 0;
  const controller = new PollingController({
    clock,
    visibility,
    visibleIntervalMs: 4_000,
    hiddenIntervalMs: 30_000,
    task: () => { calls += 1; },
  });

  visibility.hidden = true;
  controller.start();
  assert.deepEqual(clock.delays(), [30_000]);
  assert.equal(calls, 0);

  visibility.setHidden(false);
  await flushPromises();
  assert.equal(calls, 1);
  await flushPromises();
  assert.deepEqual(clock.delays(), [4_000]);

  visibility.setHidden(true);
  assert.deepEqual(clock.delays(), [30_000]);
  controller.stop();
  assert.equal(clock.count(), 0);
  assert.equal(visibility.count(), 0);
});

test("stop during an in-flight task prevents future timers", async () => {
  const clock = new FakeClock();
  const visibility = new FakeVisibility();
  const task = deferred<void>();
  const controller = new PollingController({
    clock,
    visibility,
    visibleIntervalMs: 100,
    hiddenIntervalMs: 1_000,
    task: () => task.promise,
  });

  controller.start();
  await flushPromises();
  controller.stop();
  task.resolve();
  await flushPromises();

  assert.equal(clock.count(), 0);
  assert.equal(visibility.count(), 0);
});
