import assert from "node:assert/strict";
import test from "node:test";
import {
  createLayoutSaveCoordinator,
  type LayoutSaveAuthorization,
  type LayoutSaveFailureClassification,
} from "../src/dashboard/layoutSaveCoordinator.ts";
import type { DashboardLayoutPreferences } from "../src/dashboard/layout/types.ts";

type ScheduledTask = {
  callback: () => void;
  cancelled: boolean;
  cancelCount: number;
  delayMs: number;
  fireCount: number;
};

function manualScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(callback: () => void, delayMs: number) {
      const task: ScheduledTask = {
        callback,
        cancelled: false,
        cancelCount: 0,
        delayMs,
        fireCount: 0,
      };
      tasks.push(task);
      return () => {
        if (task.cancelled) return;
        task.cancelled = true;
        task.cancelCount += 1;
      };
    },
    fire(task: ScheduledTask, force = false) {
      if (task.cancelled && !force) return;
      task.fireCount += 1;
      task.callback();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
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

function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function snapshot(label: string): DashboardLayoutPreferences {
  return {
    left: 301,
    right: 401,
    gitHeight: 211,
    sectionSplit: 221,
    automationHeight: 131,
    sessionOrder: [`session-${label}`],
    collapsedProjects: [`project-${label}`],
    pinnedItems: [{ kind: "session", name: `pinned-${label}` }],
    automationSectionCollapsed: false,
    columnOrder: ["file", "main", "scratch", "editor"],
    scratchCollapsed: false,
    scratchWidth: 381,
    fileBrowserOpen: true,
    fileTreeWidth: 311,
    editorWidth: 511,
    sidebarWidth: 321,
    inspectorWidth: 421,
    sidebarOpen: true,
    sidebarView: "files",
    inspectorOpen: false,
    inspectorTab: "diff",
    selection: { kind: "session", name: `selected-${label}` },
    editingFile: {
      path: `/repo/${label}.ts`,
      hostId: "builder",
      line: 12,
      column: 4,
    },
    diffFile: {
      path: `${label}.ts`,
      cwd: "/repo",
      hostId: "builder",
    },
    window: { width: 1400, height: 900, x: 10, y: 20, maximized: false },
  };
}

function coordinatorHarness(retryDelayMs = 3_000) {
  const scheduler = manualScheduler();
  const errors: unknown[] = [];
  const blocked: unknown[] = [];
  let recovered = 0;
  const coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: scheduler.schedule,
    retryDelayMs: () => retryDelayMs,
    onError: (error) => errors.push(error),
    onRecovered: () => { recovered += 1; },
    onBlocked: (error) => blocked.push(error),
  });
  return {
    blocked,
    coordinator,
    errors,
    recovered: () => recovered,
    scheduler,
  };
}

test("debounce keeps only the latest deeply cloned known snapshot", async () => {
  const harness = coordinatorHarness();
  const writes: DashboardLayoutPreferences[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => { writes.push(value); },
  });

  const first = snapshot("first");
  harness.coordinator.enqueue(1, first);
  const firstDebounce = harness.scheduler.tasks[0];
  const latest = snapshot("latest");
  harness.coordinator.enqueue(1, latest);
  const latestDebounce = harness.scheduler.tasks[1];
  assert.equal(firstDebounce.cancelled, true);
  assert.equal(firstDebounce.delayMs, 500);
  assert.equal(latestDebounce.delayMs, 500);

  latest.columnOrder.reverse();
  latest.sessionOrder?.push("mutated");
  latest.collapsedProjects?.push("mutated");
  if (latest.pinnedItems?.[0]?.kind === "session") latest.pinnedItems[0].name = "mutated";
  if (latest.selection?.kind === "session") latest.selection.name = "mutated";
  if (latest.editingFile) latest.editingFile.path = "/mutated";
  if (latest.diffFile) latest.diffFile.cwd = "/mutated";
  if (latest.window) latest.window.width = 1;

  harness.scheduler.fire(firstDebounce, true);
  assert.equal(writes.length, 0);
  harness.scheduler.fire(latestDebounce);
  assert.equal(writes.length, 1);
  assert.deepEqual(jsonValue(writes[0]), jsonValue(snapshot("latest")));
  await flushPromises();
  assert.equal(harness.recovered(), 0, "an ordinary first success is not recovery");
});

test("one global in-flight write serializes backend attempt switches", async () => {
  const harness = coordinatorHarness();
  const first = deferred();
  const second = deferred();
  const writes: Array<{ attempt: number; value: DashboardLayoutPreferences }> = [];
  let active = 0;
  let maxActive = 0;
  const authorization = (
    attempt: number,
    pending: ReturnType<typeof deferred>,
  ): LayoutSaveAuthorization => ({
    attempt,
    classifyFailure: () => "retry",
    write: (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push({ attempt, value });
      return pending.promise.finally(() => { active -= 1; });
    },
  });

  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize(authorization(1, first));
  harness.coordinator.enqueue(1, snapshot("old"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  assert.equal(writes.length, 1);

  harness.coordinator.beginAttempt(2);
  harness.coordinator.authorize(authorization(2, second));
  harness.coordinator.enqueue(2, snapshot("new"));
  harness.scheduler.fire(harness.scheduler.tasks[1]);
  assert.equal(writes.length, 1, "new backend must wait for the old in-flight write");
  assert.equal(maxActive, 1);

  first.resolve();
  await flushPromises();
  assert.deepEqual(writes.map(({ attempt }) => attempt), [1, 2]);
  assert.equal(maxActive, 1);
  second.resolve();
  await flushPromises();
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.blocked.length, 0);
  assert.equal(harness.recovered(), 0);
});

test("stale rejection releases the global lock without callbacks or classification", async () => {
  const harness = coordinatorHarness();
  const oldWrite = deferred();
  const newWrite = deferred();
  let oldClassifications = 0;
  const writes: number[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => { oldClassifications += 1; return "retry"; },
    write: () => { writes.push(1); return oldWrite.promise; },
  });
  harness.coordinator.enqueue(1, snapshot("old"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);

  harness.coordinator.beginAttempt(2);
  harness.coordinator.authorize({
    attempt: 2,
    classifyFailure: () => "retry",
    write: () => { writes.push(2); return newWrite.promise; },
  });
  harness.coordinator.enqueue(2, snapshot("new"));
  harness.scheduler.fire(harness.scheduler.tasks[1]);
  oldWrite.reject(new Error("stale"));
  await flushPromises();

  assert.deepEqual(writes, [1, 2]);
  assert.equal(oldClassifications, 0);
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.blocked, []);
  assert.equal(harness.recovered(), 0);
  newWrite.resolve();
  await flushPromises();
});

test("retry and debounce gates converge on the latest pending intent", async () => {
  const harness = coordinatorHarness(3_000);
  const firstWrite = deferred();
  const latestWrite = deferred();
  const writes: DashboardLayoutPreferences[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value);
      return writes.length === 1 ? firstWrite.promise : latestWrite.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  harness.coordinator.enqueue(1, snapshot("B"));
  const cancelledB = harness.scheduler.tasks[1];
  harness.coordinator.enqueue(1, snapshot("C"));
  const debounceC = harness.scheduler.tasks[2];

  const failure = new Error("offline");
  firstWrite.reject(failure);
  await flushPromises();
  const retry = harness.scheduler.tasks[3];
  assert.equal(retry.delayMs, 3_000);
  assert.deepEqual(harness.errors, [failure]);
  harness.scheduler.fire(cancelledB, true);
  harness.scheduler.fire(retry);
  assert.equal(writes.length, 1, "retry gate alone cannot bypass C's debounce");
  harness.scheduler.fire(debounceC);
  assert.equal(writes.length, 2);
  assert.deepEqual(jsonValue(writes[1]), jsonValue(snapshot("C")));
  harness.scheduler.fire(retry, true);
  assert.equal(writes.length, 2, "a consumed retry callback is identity-fenced");
  latestWrite.resolve();
  await flushPromises();
  assert.equal(harness.recovered(), 1);
});

test("recovery waits until the latest pending snapshot succeeds", async () => {
  const harness = coordinatorHarness();
  const writes = [deferred(), deferred(), deferred()];
  let writeIndex = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: () => writes[writeIndex++].promise,
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  writes[0].reject(new Error("retry"));
  await flushPromises();
  harness.scheduler.fire(harness.scheduler.tasks[1]);
  assert.equal(writeIndex, 2);

  harness.coordinator.enqueue(1, snapshot("B"));
  harness.scheduler.fire(harness.scheduler.tasks[2]);
  writes[1].resolve();
  await flushPromises();
  assert.equal(harness.recovered(), 0);
  assert.equal(writeIndex, 3);
  writes[2].resolve();
  await flushPromises();
  assert.equal(harness.recovered(), 1);
});

test("retry backoff cannot be bypassed by newer intents", async () => {
  const harness = coordinatorHarness();
  const retryWrite = deferred();
  const writes: DashboardLayoutPreferences[] = [];
  let first = true;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value);
      if (first) {
        first = false;
        throw new Error("sync retry");
      }
      return retryWrite.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  const retry = harness.scheduler.tasks[1];
  harness.coordinator.enqueue(1, snapshot("C"));
  const cancelledC = harness.scheduler.tasks[2];
  harness.coordinator.enqueue(1, snapshot("D"));
  const debounceD = harness.scheduler.tasks[3];
  harness.scheduler.fire(cancelledC, true);
  harness.scheduler.fire(debounceD);
  assert.equal(writes.length, 1);
  harness.scheduler.fire(retry);
  assert.equal(writes.length, 2);
  assert.deepEqual(jsonValue(writes[1]), jsonValue(snapshot("D")));
  retryWrite.resolve();
  await flushPromises();
  assert.equal(harness.recovered(), 1);
});

test("synchronous scheduler callbacks cross a microtask boundary between repeated synchronous failures", async () => {
  const totalWrites = 12;
  const events: string[] = [];
  const writeEpochs: number[] = [];
  let enqueueReturned = false;
  let schedulerEpoch = 0;
  let writes = 0;
  let resolveBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resolveBlocked = resolve;
  });
  const coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: (callback) => {
      callback();
      queueMicrotask(() => {
        schedulerEpoch += 1;
      });
      return () => {};
    },
    retryDelayMs: () => 3_000,
    onError: () => {
      events.push(`error:${writes}`);
    },
    onRecovered: () => assert.fail("a blocked retry chain cannot recover"),
    onBlocked: () => {
      events.push(`blocked:${writes}`);
      resolveBlocked();
    },
  });
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => writes < totalWrites ? "retry" : "block",
    write: () => {
      writes += 1;
      events.push(`write:${writes}`);
      writeEpochs.push(schedulerEpoch);
      assert.equal(enqueueReturned, true);
      throw new Error(`failure ${writes}`);
    },
  });

  coordinator.enqueue(1, snapshot("sync-scheduler"));
  enqueueReturned = true;
  assert.equal(writes, 0, "a synchronously fired debounce must not write on the enqueue stack");
  await blocked;

  assert.equal(writes, totalWrites);
  assert.deepEqual(
    writeEpochs,
    Array.from({ length: totalWrites }, (_, index) => index + 1),
    "each synchronous retry must resume after its scheduler call stack returns",
  );
  const expectedEvents: string[] = [];
  for (let index = 1; index <= totalWrites; index += 1) {
    expectedEvents.push(`write:${index}`);
    expectedEvents.push(index === totalWrites ? `blocked:${index}` : `error:${index}`);
  }
  assert.deepEqual(events, expectedEvents);
});

test("same-attempt reauthorization during retry notification uses the replacement writer", async () => {
  const scheduler = manualScheduler();
  const events: string[] = [];
  const retried = deferred();
  let coordinator: ReturnType<typeof createLayoutSaveCoordinator>;
  const replacementAuthorization: LayoutSaveAuthorization = {
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      events.push(value.sessionOrder?.[0] ?? "replacement-missing");
      return retried.promise;
    },
  };
  coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: scheduler.schedule,
    retryDelayMs: () => 3_000,
    onError: () => {
      events.push("error");
      coordinator.authorize(replacementAuthorization);
    },
    onRecovered: () => events.push("recovered"),
    onBlocked: () => assert.fail("a retryable failure must not block"),
  });
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: () => {
      events.push("original");
      throw new Error("replace me");
    },
  });
  coordinator.enqueue(1, snapshot("replacement"));
  scheduler.fire(scheduler.tasks[0]);

  assert.deepEqual(events, ["original", "error"]);
  assert.equal(scheduler.tasks.length, 2);
  assert.equal(scheduler.tasks[1].delayMs, 3_000);
  scheduler.fire(scheduler.tasks[1]);
  assert.deepEqual(events, ["original", "error", "session-replacement"]);
  retried.resolve();
  await flushPromises();
  assert.deepEqual(events, ["original", "error", "session-replacement", "recovered"]);
});

test("nonretryable failure blocks before notification and rejects reentrant enqueue", async () => {
  const scheduler = manualScheduler();
  const blocked: unknown[] = [];
  const errors: unknown[] = [];
  let coordinator: ReturnType<typeof createLayoutSaveCoordinator>;
  let writes = 0;
  coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: scheduler.schedule,
    retryDelayMs: () => 3_000,
    onError: (error) => errors.push(error),
    onRecovered: () => assert.fail("blocked writes cannot recover"),
    onBlocked: (error) => {
      blocked.push(error);
      coordinator.enqueue(1, snapshot("reentrant"));
    },
  });
  const failure = new Error("do not retry");
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: (): LayoutSaveFailureClassification => "block",
    write: () => {
      writes += 1;
      throw failure;
    },
  });
  coordinator.enqueue(1, snapshot("blocked"));
  scheduler.fire(scheduler.tasks[0]);
  await flushPromises();

  assert.equal(writes, 1);
  assert.deepEqual(blocked, [failure]);
  assert.deepEqual(errors, []);
  assert.equal(scheduler.tasks.length, 1, "nonretryable failure schedules no blind retry");
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async () => { writes += 1; },
  });
  coordinator.enqueue(1, snapshot("still-blocked"));
  assert.equal(scheduler.tasks.length, 1);
});

test("asynchronous nonretryable rejection blocks without retry", async () => {
  const harness = coordinatorHarness();
  const failure = new Error("blocked rejection");
  let writes = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "block",
    write: () => {
      writes += 1;
      return Promise.reject(failure);
    },
  });
  harness.coordinator.enqueue(1, snapshot("blocked-async"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  await flushPromises();
  assert.equal(writes, 1);
  assert.deepEqual(harness.blocked, [failure]);
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.scheduler.tasks.length, 1);
});

test("block and stop cancel tasks while stale callbacks and settles stay inert", async () => {
  const harness = coordinatorHarness();
  const inFlight = deferred();
  let writes = 0;
  harness.coordinator.beginAttempt(2);
  harness.coordinator.authorize({
    attempt: 2,
    classifyFailure: () => "retry",
    write: () => { writes += 1; return inFlight.promise; },
  });
  harness.coordinator.enqueue(2, snapshot("pending"));
  const pendingTimer = harness.scheduler.tasks[0];
  harness.coordinator.block(1);
  assert.equal(pendingTimer.cancelled, false, "stale block cannot affect current attempt");
  harness.coordinator.block(2);
  assert.equal(pendingTimer.cancelled, true);
  harness.scheduler.fire(pendingTimer, true);
  assert.equal(writes, 0);

  harness.coordinator.beginAttempt(3);
  harness.coordinator.authorize({
    attempt: 3,
    classifyFailure: () => "retry",
    write: () => { writes += 1; return inFlight.promise; },
  });
  harness.coordinator.enqueue(3, snapshot("in-flight"));
  harness.scheduler.fire(harness.scheduler.tasks[1]);
  assert.equal(writes, 1);
  harness.coordinator.stop();
  harness.coordinator.stop();
  inFlight.reject(new Error("after stop"));
  await flushPromises();
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.blocked, []);
  assert.equal(harness.recovered(), 0);

  harness.coordinator.beginAttempt(4);
  harness.coordinator.authorize({
    attempt: 4,
    classifyFailure: () => "retry",
    write: async () => { writes += 1; },
  });
  harness.coordinator.enqueue(4, snapshot("after-stop"));
  assert.equal(harness.scheduler.tasks.length, 2, "stop is permanent");
});

test("stop cancels retry and remains inert when write stops reentrantly", async () => {
  {
    const harness = coordinatorHarness();
    const write = deferred();
    let writes = 0;
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: () => { writes += 1; return write.promise; },
    });
    harness.coordinator.enqueue(1, snapshot("retry-stop"));
    harness.scheduler.fire(harness.scheduler.tasks[0]);
    write.reject(new Error("retry"));
    await flushPromises();
    const retry = harness.scheduler.tasks[1];
    harness.coordinator.stop();
    harness.coordinator.stop();
    assert.equal(retry.cancelCount, 1);
    harness.scheduler.fire(retry, true);
    assert.equal(writes, 1);
    assert.equal(harness.recovered(), 0);
  }

  {
    const harness = coordinatorHarness();
    let writes = 0;
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: async () => {
        writes += 1;
        harness.coordinator.stop();
      },
    });
    harness.coordinator.enqueue(1, snapshot("sync-stop"));
    harness.scheduler.fire(harness.scheduler.tasks[0]);
    await flushPromises();
    assert.equal(writes, 1);
    assert.deepEqual(harness.errors, []);
    assert.deepEqual(harness.blocked, []);
    assert.equal(harness.recovered(), 0);
  }
});

test("attempts are monotonic and stale API calls cannot disturb current work", async () => {
  const harness = coordinatorHarness();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(2);
  harness.coordinator.authorize({
    attempt: 2,
    classifyFailure: () => "retry",
    write: async (value) => { writes.push(value.sessionOrder?.[0] ?? "missing"); },
  });
  harness.coordinator.enqueue(2, snapshot("current"));
  const timer = harness.scheduler.tasks[0];
  harness.coordinator.beginAttempt(2);
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "block",
    write: async () => { writes.push("stale"); },
  });
  harness.coordinator.enqueue(1, snapshot("stale"));
  harness.coordinator.block(1);
  harness.scheduler.fire(timer);
  await flushPromises();
  assert.deepEqual(writes, ["session-current"]);

  harness.coordinator.beginAttempt(3);
  harness.coordinator.authorize({
    attempt: 3,
    classifyFailure: () => "retry",
    write: async (value) => { writes.push(value.sessionOrder?.[0] ?? "missing"); },
  });
  harness.coordinator.enqueue(3, snapshot("cleared"));
  const clearedTimer = harness.scheduler.tasks[1];
  harness.coordinator.beginAttempt(4);
  assert.equal(clearedTimer.cancelled, true);
  harness.scheduler.fire(clearedTimer, true);
  assert.deepEqual(writes, ["session-current"]);
});
