import assert from "node:assert/strict";
import test from "node:test";
import {
  createWindowCloseBridge,
  type NativeDashboardCloseRequest,
} from "../src/platform/windowCloseBridge.ts";

type ScheduledTask = {
  callback: () => void;
  cancelled: boolean;
  cancelCount: number;
  delayMs: number;
};

function manualScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(callback: () => void, delayMs: number) {
      const task = { callback, cancelled: false, cancelCount: 0, delayMs };
      tasks.push(task);
      return () => {
        if (task.cancelled) return;
        task.cancelled = true;
        task.cancelCount += 1;
      };
    },
    fire(task: ScheduledTask, force = false) {
      if (task.cancelled && !force) return;
      task.callback();
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function bridgeHarness() {
  const scheduler = manualScheduler();
  const events: string[] = [];
  let nativeHandler: ((event: NativeDashboardCloseRequest) => void) | null = null;
  let registrationCount = 0;
  let destroyCount = 0;
  let destroyImplementation: () => Promise<void> = async () => {};
  const bridge = createWindowCloseBridge({
    onCloseRequested(handler) {
      registrationCount += 1;
      nativeHandler = handler;
      return Promise.resolve(() => {});
    },
    destroy() {
      destroyCount += 1;
      return destroyImplementation();
    },
    schedule: scheduler.schedule,
  });
  return {
    bridge,
    destroyCount: () => destroyCount,
    emitClose(label: string) {
      assert.ok(nativeHandler);
      nativeHandler({
        preventDefault() {
          events.push(`prevent:${label}`);
        },
      });
    },
    events,
    registrationCount: () => registrationCount,
    scheduler,
    setDestroy(implementation: () => Promise<void>) {
      destroyImplementation = implementation;
    },
  };
}

test("close prevention is synchronous and a pre-bind close latches one shared cycle", async () => {
  const harness = bridgeHarness();
  const handlerDone = deferred();
  const signals: AbortSignal[] = [];

  assert.equal(harness.registrationCount(), 1);
  harness.emitClose("first");
  harness.emitClose("repeat-before-bind");
  assert.deepEqual(harness.events, ["prevent:first", "prevent:repeat-before-bind"]);
  assert.equal(harness.scheduler.tasks.length, 1);
  assert.equal(harness.scheduler.tasks[0].delayMs, 2_000);

  harness.bridge.bind((candidateSignal) => {
    signals.push(candidateSignal);
    harness.events.push(`handler:${candidateSignal.aborted}`);
    return handlerDone.promise;
  });
  assert.deepEqual(harness.events, [
    "prevent:first",
    "prevent:repeat-before-bind",
    "handler:false",
  ]);
  harness.emitClose("repeat-with-handler");
  assert.equal(harness.scheduler.tasks.length, 1);
  assert.equal(harness.destroyCount(), 0);

  handlerDone.resolve();
  await flushPromises();
  assert.equal(signals[0].aborted, true);
  assert.equal(harness.scheduler.tasks[0].cancelCount, 1);
  assert.equal(harness.destroyCount(), 1);
  harness.emitClose("after-destroy");
  assert.equal(harness.destroyCount(), 1);
});

test("bind cleanup is token-safe across StrictMode replacement", async () => {
  const harness = bridgeHarness();
  const handlerDone = deferred();
  const handlers: string[] = [];
  const cleanupOld = harness.bridge.bind(() => {
    handlers.push("old");
  });
  const cleanupCurrent = harness.bridge.bind(() => {
    handlers.push("current");
    return handlerDone.promise;
  });
  cleanupOld();
  harness.emitClose("strict-mode");
  assert.deepEqual(handlers, ["current"]);
  cleanupCurrent();
  handlerDone.resolve();
  await flushPromises();
  assert.equal(harness.destroyCount(), 1);
});

test("sync throw and async rejection both abort and destroy without escaping", async () => {
  for (const mode of ["throw", "reject"] as const) {
    const harness = bridgeHarness();
    const signals: AbortSignal[] = [];
    harness.bridge.bind((candidateSignal) => {
      signals.push(candidateSignal);
      if (mode === "throw") throw new Error("sync close failure");
      return Promise.reject(new Error("async close failure"));
    });
    harness.emitClose(mode);
    await flushPromises();
    assert.equal(signals[0].aborted, true);
    assert.equal(harness.destroyCount(), 1);
    assert.equal(harness.scheduler.tasks[0].cancelCount, 1);
  }
});

test("deadline aborts a pending handler and late work cannot duplicate destroy", async () => {
  const harness = bridgeHarness();
  const handlerDone = deferred();
  const destroyDone = deferred();
  const signals: AbortSignal[] = [];
  harness.setDestroy(() => destroyDone.promise);
  harness.bridge.bind((candidateSignal) => {
    signals.push(candidateSignal);
    return handlerDone.promise;
  });
  harness.emitClose("deadline");
  const deadline = harness.scheduler.tasks[0];
  harness.scheduler.fire(deadline);
  assert.equal(signals[0].aborted, true);
  assert.equal(harness.destroyCount(), 1);

  harness.emitClose("destroy-pending");
  handlerDone.reject(new Error("late handler rejection"));
  harness.scheduler.fire(deadline, true);
  await flushPromises();
  assert.equal(harness.scheduler.tasks.length, 1);
  assert.equal(harness.destroyCount(), 1);
  destroyDone.resolve();
  await flushPromises();
  harness.emitClose("destroyed");
  assert.equal(harness.destroyCount(), 1);
});

test("an unbound cycle still destroys at the original deadline", async () => {
  const harness = bridgeHarness();
  harness.emitClose("unbound");
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  await flushPromises();
  assert.equal(harness.destroyCount(), 1);
});

test("destroy rejection clears only that cycle and late handler settle is inert", async () => {
  const harness = bridgeHarness();
  const oldHandler = deferred();
  const currentHandler = deferred();
  const firstDestroy = deferred();
  const secondDestroy = deferred();
  const handlerSignals: AbortSignal[] = [];
  let handlerCall = 0;
  let destroyCall = 0;
  harness.bridge.bind((signal) => {
    handlerSignals.push(signal);
    handlerCall += 1;
    return handlerCall === 1 ? oldHandler.promise : currentHandler.promise;
  });
  harness.setDestroy(() => {
    destroyCall += 1;
    return destroyCall === 1 ? firstDestroy.promise : secondDestroy.promise;
  });

  harness.emitClose("first");
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  firstDestroy.reject(new Error("native destroy failed"));
  await flushPromises();
  assert.equal(handlerSignals[0].aborted, true);

  harness.emitClose("retry");
  assert.equal(handlerCall, 2);
  oldHandler.resolve();
  await flushPromises();
  assert.equal(harness.destroyCount(), 1);
  currentHandler.resolve();
  await flushPromises();
  assert.equal(handlerSignals[1].aborted, true);
  assert.equal(harness.destroyCount(), 2);
  secondDestroy.resolve();
  await flushPromises();
});

test("registration rejection and synchronous throw are fully contained", async () => {
  for (const mode of ["throw", "reject"] as const) {
    let registrations = 0;
    createWindowCloseBridge({
      onCloseRequested() {
        registrations += 1;
        if (mode === "throw") throw new Error("registration threw");
        return Promise.reject(new Error("registration rejected"));
      },
      destroy: async () => {},
      schedule: manualScheduler().schedule,
    });
    await flushPromises();
    assert.equal(registrations, 1);
  }
});
