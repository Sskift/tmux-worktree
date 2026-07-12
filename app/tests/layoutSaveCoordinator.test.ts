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

function trackedAbortSignal() {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string, listener: () => void) {
      assert.equal(type, "abort");
      listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      assert.equal(type, "abort");
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;
  return {
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
    listenerCount: () => listeners.size,
    signal,
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
    pending: { promise: Promise<void> },
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

test("exact retry runs before the debounced latest intent", async () => {
  const harness = coordinatorHarness(3_000);
  const firstWrite = deferred();
  const exactWrite = deferred();
  const latestWrite = deferred();
  const writes: DashboardLayoutPreferences[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value);
      if (writes.length === 1) return firstWrite.promise;
      if (writes.length === 2) return exactWrite.promise;
      return latestWrite.promise;
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
  assert.equal(writes.length, 2, "the exact failed snapshot ignores the latest debounce gate");
  assert.deepEqual(jsonValue(writes[1]), jsonValue(snapshot("A")));
  harness.scheduler.fire(debounceC);
  assert.equal(writes.length, 2, "latest cannot overlap the exact retry");
  exactWrite.resolve();
  await flushPromises();
  assert.equal(writes.length, 3);
  assert.deepEqual(jsonValue(writes[2]), jsonValue(snapshot("C")));
  harness.scheduler.fire(retry, true);
  assert.equal(writes.length, 3, "a consumed retry callback is identity-fenced");
  latestWrite.resolve();
  await flushPromises();
  assert.equal(harness.recovered(), 1);
});

test("ambiguous commit replays exact A before bounded latest C and advances revision", async () => {
  const harness = coordinatorHarness();
  const first = deferred<string>();
  const exact = deferred<string>();
  const latest = deferred<string>();
  const responses = [first, exact, latest];
  const writes: Array<{ revision: string; session: string }> = [];
  let expectedRevision = "revision-0";
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => {
      writes.push({
        revision: expectedRevision,
        session: value.sessionOrder?.[0] ?? "missing",
      });
      const response = responses.shift();
      assert.ok(response);
      expectedRevision = await response.promise;
    },
  });

  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  harness.coordinator.enqueue(1, snapshot("B"));
  const discardedB = harness.scheduler.tasks[1];
  harness.coordinator.enqueue(1, snapshot("C"));
  const debounceC = harness.scheduler.tasks[2];
  assert.equal(discardedB.cancelled, true);
  harness.scheduler.fire(debounceC);

  first.reject(new Error("commit response was lost"));
  await flushPromises();
  const retry = harness.scheduler.tasks[3];
  harness.scheduler.fire(retry);
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
  ]);

  exact.resolve("revision-1");
  await flushPromises();
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-1", session: "session-C" },
  ]);
  assert.equal(
    writes.some(({ session }) => session === "session-B"),
    false,
    "the coordinator retains only exact A plus latest C",
  );
  latest.resolve("revision-2");
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
  const latestWrite = deferred();
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
      return writes.length === 2 ? retryWrite.promise : latestWrite.promise;
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
  assert.deepEqual(jsonValue(writes[1]), jsonValue(snapshot("A")));
  retryWrite.resolve();
  await flushPromises();
  assert.equal(writes.length, 3);
  assert.deepEqual(jsonValue(writes[2]), jsonValue(snapshot("D")));
  latestWrite.resolve();
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

test("a newer attempt clears exact retry and latest slots", async () => {
  const harness = coordinatorHarness();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      throw new Error("ambiguous old attempt");
    },
  });
  harness.coordinator.enqueue(1, snapshot("old"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  const staleRetry = harness.scheduler.tasks[1];
  harness.coordinator.enqueue(1, snapshot("old-latest"));
  const staleDebounce = harness.scheduler.tasks[2];

  harness.coordinator.beginAttempt(2);
  assert.equal(staleRetry.cancelled, true);
  assert.equal(staleDebounce.cancelled, true);
  harness.coordinator.authorize({
    attempt: 2,
    classifyFailure: () => "retry",
    write: async (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
    },
  });
  harness.coordinator.enqueue(2, snapshot("new"));
  harness.scheduler.fire(staleRetry, true);
  harness.scheduler.fire(staleDebounce, true);
  harness.scheduler.fire(harness.scheduler.tasks[3]);
  await flushPromises();
  assert.deepEqual(writes, ["session-old", "session-new"]);
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

test("flush replaces a pending debounce with one deeply cloned ready final snapshot", async () => {
  const harness = coordinatorHarness();
  const write = deferred();
  const writes: DashboardLayoutPreferences[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value);
      return write.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("debounced"));
  const debounce = harness.scheduler.tasks[0];
  const finalSnapshot = snapshot("final");
  const signal = trackedAbortSignal();
  let outcome: string | undefined;
  const flush = harness.coordinator.flush(1, finalSnapshot, signal.signal);
  void flush.then((value) => { outcome = value; });

  assert.equal(debounce.cancelCount, 1);
  assert.equal(writes.length, 1);
  assert.equal(outcome, undefined);
  assert.equal(signal.listenerCount(), 1);
  finalSnapshot.sessionOrder?.push("mutated-after-flush");
  if (finalSnapshot.window) finalSnapshot.window.width = 1;
  assert.deepEqual(jsonValue(writes[0]), jsonValue(snapshot("final")));
  harness.scheduler.fire(debounce, true);
  assert.equal(writes.length, 1);

  write.resolve();
  assert.equal(await flush, "flushed");
  assert.equal(outcome, "flushed");
  assert.equal(signal.listenerCount(), 0);
});

test("flush waits for in-flight work then writes only its final snapshot", async () => {
  const harness = coordinatorHarness();
  const first = deferred();
  const finalWrite = deferred();
  const writes: string[] = [];
  let active = 0;
  let maxActive = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push(value.sessionOrder?.[0] ?? "missing");
      const pending = writes.length === 1 ? first : finalWrite;
      return pending.promise.finally(() => { active -= 1; });
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  harness.coordinator.enqueue(1, snapshot("discarded"));
  const discardedDebounce = harness.scheduler.tasks[1];
  const controller = new AbortController();
  let outcome: string | undefined;
  const flush = harness.coordinator.flush(1, snapshot("final"), controller.signal);
  void flush.then((value) => { outcome = value; });
  harness.coordinator.enqueue(1, snapshot("reentrant-enqueue"));
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "block",
    write: async () => { writes.push("replacement-writer"); },
  });

  assert.equal(discardedDebounce.cancelled, true);
  assert.deepEqual(writes, ["session-A"]);
  assert.equal(outcome, undefined);
  first.resolve();
  await flushPromises();
  assert.deepEqual(writes, ["session-A", "session-final"]);
  assert.equal(maxActive, 1);
  assert.equal(outcome, undefined);
  finalWrite.resolve();
  assert.equal(await flush, "flushed");
  assert.equal(maxActive, 1);
  assert.equal(harness.scheduler.tasks.length, 2);
});

test("flush cancels existing backoff and preserves exact A before revisioned final", async () => {
  const harness = coordinatorHarness();
  const first = deferred<string>();
  const exact = deferred<string>();
  const finalWrite = deferred<string>();
  const responses = [first, exact, finalWrite];
  const writes: Array<{ revision: string; session: string }> = [];
  let expectedRevision = "revision-0";
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => {
      writes.push({
        revision: expectedRevision,
        session: value.sessionOrder?.[0] ?? "missing",
      });
      const response = responses.shift();
      assert.ok(response);
      expectedRevision = await response.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  first.reject(new Error("ambiguous A"));
  await flushPromises();
  const backoff = harness.scheduler.tasks[1];
  harness.coordinator.enqueue(1, snapshot("discarded"));
  const discardedDebounce = harness.scheduler.tasks[2];

  const flush = harness.coordinator.flush(
    1,
    snapshot("final"),
    new AbortController().signal,
  );
  assert.equal(backoff.cancelCount, 1);
  assert.equal(discardedDebounce.cancelCount, 1);
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
  ]);
  harness.scheduler.fire(backoff, true);
  harness.scheduler.fire(discardedDebounce, true);
  assert.equal(writes.length, 2);

  exact.resolve("revision-1");
  await flushPromises();
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-1", session: "session-final" },
  ]);
  finalWrite.resolve("revision-2");
  assert.equal(await flush, "flushed");
});

test("flush abort during external backoff cancellation restores a normal exact retry", async () => {
  const scheduler = manualScheduler();
  const errors: unknown[] = [];
  const blocked: unknown[] = [];
  let recovered = 0;
  let abortOnBackoffCancel: (() => void) | null = null;
  let shouldAbortOnBackoffCancel = false;
  const coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule(callback, delayMs) {
      const cancelScheduled = scheduler.schedule(callback, delayMs);
      return () => {
        cancelScheduled();
        if (delayMs === 3_000 && shouldAbortOnBackoffCancel) {
          shouldAbortOnBackoffCancel = false;
          abortOnBackoffCancel?.();
        }
      };
    },
    retryDelayMs: () => 3_000,
    onError: (error) => errors.push(error),
    onRecovered: () => { recovered += 1; },
    onBlocked: (error) => blocked.push(error),
  });
  const first = deferred();
  const exact = deferred();
  const responses = [first, exact];
  const writes: string[] = [];
  let active = 0;
  let maxActive = 0;
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push(value.sessionOrder?.[0] ?? "missing");
      const response = responses.shift();
      assert.ok(response);
      try {
        await response.promise;
      } finally {
        active -= 1;
      }
    },
  });
  coordinator.enqueue(1, snapshot("A"));
  scheduler.fire(scheduler.tasks[0]);
  first.reject(new Error("ambiguous A"));
  await flushPromises();
  const originalBackoff = scheduler.tasks[1];
  assert.equal(originalBackoff.delayMs, 3_000);

  const signal = trackedAbortSignal();
  abortOnBackoffCancel = signal.abort;
  shouldAbortOnBackoffCancel = true;
  const flush = coordinator.flush(1, snapshot("cancelled-final"), signal.signal);
  assert.equal(await flush, "cancelled");
  assert.equal(signal.listenerCount(), 0);
  assert.deepEqual(writes, ["session-A"]);
  assert.equal(originalBackoff.cancelCount, 1);
  const restoredBackoff = scheduler.tasks[2];
  assert.equal(restoredBackoff.delayMs, 3_000);
  assert.equal(restoredBackoff.cancelled, false);

  scheduler.fire(originalBackoff, true);
  assert.deepEqual(writes, ["session-A"]);
  scheduler.fire(restoredBackoff);
  assert.deepEqual(writes, ["session-A", "session-A"]);
  assert.equal(maxActive, 1);
  exact.resolve();
  await flushPromises();
  assert.equal(maxActive, 1);
  assert.equal(errors.length, 1);
  assert.deepEqual(blocked, []);
  assert.equal(recovered, 1);
});

test("flush fences an in-flight ambiguous A through exact A before the final revision", async () => {
  const harness = coordinatorHarness();
  const first = deferred<string>();
  const exact = deferred<string>();
  const finalWrite = deferred<string>();
  const responses = [first, exact, finalWrite];
  const writes: Array<{ revision: string; session: string }> = [];
  let expectedRevision = "revision-0";
  let active = 0;
  let maxActive = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push({
        revision: expectedRevision,
        session: value.sessionOrder?.[0] ?? "missing",
      });
      const response = responses.shift();
      assert.ok(response);
      try {
        expectedRevision = await response.promise;
      } finally {
        active -= 1;
      }
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  const signal = trackedAbortSignal();
  const flush = harness.coordinator.flush(1, snapshot("final"), signal.signal);

  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
  ]);
  first.reject(new Error("ambiguous A"));
  await flushPromises();
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
  ]);
  assert.equal(maxActive, 1);

  exact.resolve("revision-1");
  await flushPromises();
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-0", session: "session-A" },
    { revision: "revision-1", session: "session-final" },
  ]);
  assert.equal(maxActive, 1);
  finalWrite.resolve("revision-2");
  assert.equal(await flush, "flushed");
  assert.equal(signal.listenerCount(), 0);
  assert.equal(maxActive, 1);
});

test("a final ambiguous write gets one immediate exact retry then normal backoff", async () => {
  const harness = coordinatorHarness();
  const finalSuccess = deferred();
  const writes: string[] = [];
  let writeCount = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writeCount += 1;
      writes.push(value.sessionOrder?.[0] ?? "missing");
      if (writeCount <= 2) throw new Error(`ambiguous ${writeCount}`);
      return finalSuccess.promise;
    },
  });
  let outcome: string | undefined;
  const flush = harness.coordinator.flush(
    1,
    snapshot("final-ambiguous"),
    new AbortController().signal,
  );
  void flush.then((value) => { outcome = value; });
  assert.equal(writeCount, 1);
  await flushPromises();
  assert.equal(writeCount, 2, "the first exact retry is released through one microtask");
  assert.equal(harness.scheduler.tasks.length, 1);
  const normalBackoff = harness.scheduler.tasks[0];
  assert.equal(normalBackoff.delayMs, 3_000);
  await flushPromises();
  assert.equal(writeCount, 2, "the exact retry cannot create a microtask spin");
  assert.equal(outcome, undefined);

  harness.scheduler.fire(normalBackoff);
  assert.equal(writeCount, 3);
  assert.deepEqual(writes, [
    "session-final-ambiguous",
    "session-final-ambiguous",
    "session-final-ambiguous",
  ]);
  finalSuccess.resolve();
  assert.equal(await flush, "flushed");
  assert.equal(harness.recovered(), 1);
});

test("recovery atomically settles flush before reentrant lifecycle notifications", async () => {
  for (const action of ["block", "begin", "stop", "abort"] as const) {
    const scheduler = manualScheduler();
    const signal = trackedAbortSignal();
    const exact = deferred();
    const events: string[] = [];
    let coordinator: ReturnType<typeof createLayoutSaveCoordinator>;
    let writeCount = 0;
    coordinator = createLayoutSaveCoordinator({
      debounceMs: 500,
      schedule: scheduler.schedule,
      retryDelayMs: () => 3_000,
      onError: () => events.push("error"),
      onRecovered: () => {
        assert.equal(signal.listenerCount(), 0);
        events.push(`recovered:${action}`);
        if (action === "block") coordinator.block(1);
        else if (action === "begin") coordinator.beginAttempt(2);
        else if (action === "stop") coordinator.stop();
        else signal.abort();
      },
      onBlocked: () => assert.fail("retry recovery must not block"),
    });
    coordinator.beginAttempt(1);
    coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: () => {
        writeCount += 1;
        if (writeCount === 1) throw new Error(`ambiguous:${action}`);
        return exact.promise;
      },
    });
    const flush = coordinator.flush(1, snapshot(action), signal.signal);
    assert.equal(signal.listenerCount(), 1);
    await flushPromises();
    assert.equal(writeCount, 2);

    exact.resolve();
    assert.equal(await flush, "flushed");
    assert.equal(signal.listenerCount(), 0);
    assert.deepEqual(events, ["error", `recovered:${action}`]);
  }
});

test("flush resolves blocked after a nonretryable failure and rejects reentrant work", async () => {
  const scheduler = manualScheduler();
  const events: string[] = [];
  let coordinator: ReturnType<typeof createLayoutSaveCoordinator>;
  coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: scheduler.schedule,
    retryDelayMs: () => 3_000,
    onError: () => events.push("error"),
    onRecovered: () => events.push("recovered"),
    onBlocked: () => {
      events.push("blocked");
      coordinator.enqueue(1, snapshot("blocked-reentrant"));
    },
  });
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "block",
    write: () => {
      events.push("write");
      throw new Error("conflict");
    },
  });
  const signal = trackedAbortSignal();
  const flush = coordinator.flush(
    1,
    snapshot("blocked-final"),
    signal.signal,
  );
  void flush.then((result) => events.push(result));
  assert.equal(await flush, "blocked");
  assert.equal(signal.listenerCount(), 0);
  await flushPromises();
  assert.deepEqual(events, ["write", "blocked", "blocked"]);
  assert.equal(scheduler.tasks.length, 0);
});

test("retry notification reentrancy cannot replace a finalizing transaction", async () => {
  const scheduler = manualScheduler();
  const exact = deferred();
  const writes: string[] = [];
  let coordinator: ReturnType<typeof createLayoutSaveCoordinator>;
  let firstFlush: Promise<"flushed" | "blocked" | "stale" | "cancelled">;
  let reentrantFlush: Promise<"flushed" | "blocked" | "stale" | "cancelled"> | null = null;
  let writeCount = 0;
  coordinator = createLayoutSaveCoordinator({
    debounceMs: 500,
    schedule: scheduler.schedule,
    retryDelayMs: () => 3_000,
    onError: () => {
      coordinator.enqueue(1, snapshot("ignored-from-error"));
      coordinator.authorize({
        attempt: 1,
        classifyFailure: () => "block",
        write: async () => { writes.push("replacement-writer"); },
      });
      reentrantFlush = coordinator.flush(
        1,
        snapshot("ignored-from-error-flush"),
        new AbortController().signal,
      );
    },
    onRecovered: () => {},
    onBlocked: () => assert.fail("the immediate exact retry must remain retryable"),
  });
  coordinator.beginAttempt(1);
  coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writeCount += 1;
      writes.push(value.sessionOrder?.[0] ?? "missing");
      if (writeCount === 1) throw new Error("ambiguous final");
      return exact.promise;
    },
  });
  firstFlush = coordinator.flush(
    1,
    snapshot("owned-final"),
    new AbortController().signal,
  );
  await flushPromises();
  assert.strictEqual(reentrantFlush, firstFlush);
  assert.deepEqual(writes, ["session-owned-final", "session-owned-final"]);
  exact.resolve();
  assert.equal(await firstFlush, "flushed");
});

test("flush converts clone and signal protocol failures into settled outcomes", async () => {
  {
    const harness = coordinatorHarness();
    let writes = 0;
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: async () => { writes += 1; },
    });
    const cloneFailure = new Error("snapshot getter failed");
    const malformed = Object.create(null) as DashboardLayoutPreferences;
    Object.defineProperty(malformed, "columnOrder", {
      enumerable: true,
      get() {
        throw cloneFailure;
      },
    });
    assert.equal(
      await harness.coordinator.flush(
        1,
        malformed,
        new AbortController().signal,
      ),
      "blocked",
    );
    assert.equal(writes, 0);
    assert.deepEqual(harness.blocked, [cloneFailure]);
  }

  {
    const harness = coordinatorHarness();
    const writes: string[] = [];
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: async (value) => {
        writes.push(value.sessionOrder?.[0] ?? "missing");
      },
    });
    const brokenSignal = {
      aborted: false,
      addEventListener() {
        throw new Error("cannot register abort listener");
      },
      removeEventListener() {},
    } as unknown as AbortSignal;
    assert.equal(
      await harness.coordinator.flush(1, snapshot("cancelled"), brokenSignal),
      "cancelled",
    );
    harness.coordinator.enqueue(1, snapshot("after-signal-failure"));
    harness.scheduler.fire(harness.scheduler.tasks[0]);
    await flushPromises();
    assert.deepEqual(writes, ["session-after-signal-failure"]);
  }
});

test("stale unauthorized blocked and already-aborted flushes perform no work", async () => {
  {
    const harness = coordinatorHarness();
    assert.equal(
      await harness.coordinator.flush(
        1,
        snapshot("unauthorized"),
        new AbortController().signal,
      ),
      "stale",
    );
    assert.equal(harness.scheduler.tasks.length, 0);
  }

  {
    const harness = coordinatorHarness();
    let writes = 0;
    harness.coordinator.beginAttempt(2);
    harness.coordinator.authorize({
      attempt: 2,
      classifyFailure: () => "retry",
      write: async () => { writes += 1; },
    });
    harness.coordinator.enqueue(2, snapshot("current"));
    const currentDebounce = harness.scheduler.tasks[0];
    assert.equal(
      await harness.coordinator.flush(
        1,
        snapshot("stale"),
        new AbortController().signal,
      ),
      "stale",
    );
    assert.equal(currentDebounce.cancelled, false);
    harness.coordinator.block(2);
    assert.equal(
      await harness.coordinator.flush(
        2,
        snapshot("blocked"),
        new AbortController().signal,
      ),
      "stale",
    );
    assert.equal(writes, 0);
  }

  {
    const harness = coordinatorHarness();
    let writes = 0;
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: async () => { writes += 1; },
    });
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await harness.coordinator.flush(1, snapshot("aborted"), controller.signal),
      "cancelled",
    );
    assert.equal(writes, 0);
  }
});

test("repeated flush shares the first promise snapshot signal and authorization", async () => {
  const harness = coordinatorHarness();
  const write = deferred();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      return write.promise;
    },
  });
  const firstSignal = trackedAbortSignal();
  const ignoredSignal = trackedAbortSignal();
  const first = harness.coordinator.flush(1, snapshot("first-final"), firstSignal.signal);
  const repeated = harness.coordinator.flush(
    1,
    snapshot("ignored-final"),
    ignoredSignal.signal,
  );
  assert.strictEqual(repeated, first);
  assert.deepEqual(writes, ["session-first-final"]);
  assert.equal(firstSignal.listenerCount(), 1);
  assert.equal(ignoredSignal.listenerCount(), 0);
  ignoredSignal.abort();
  harness.coordinator.enqueue(1, snapshot("ignored-enqueue"));
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "block",
    write: async () => { writes.push("ignored-authorization"); },
  });
  assert.deepEqual(writes, ["session-first-final"]);

  write.resolve();
  assert.equal(await first, "flushed");
  assert.equal(firstSignal.listenerCount(), 0);
});

test("signal abort cancels final pending while in-flight work settles normally", async () => {
  const harness = coordinatorHarness();
  const inFlight = deferred();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      return inFlight.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("A"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  const signal = trackedAbortSignal();
  const flush = harness.coordinator.flush(1, snapshot("cancelled-final"), signal.signal);
  signal.abort();
  assert.equal(await flush, "cancelled");
  assert.equal(signal.listenerCount(), 0);
  inFlight.resolve();
  await flushPromises();
  assert.deepEqual(writes, ["session-A"]);

  const resumed = deferred();
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      return resumed.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("resumed"));
  harness.scheduler.fire(harness.scheduler.tasks.at(-1)!);
  assert.deepEqual(writes, ["session-A", "session-resumed"]);
  resumed.resolve();
  await flushPromises();
});

test("aborting an in-flight final only cancels its waiter and late success keeps reuse valid", async () => {
  const harness = coordinatorHarness();
  const finalWrite = deferred();
  const resumed = deferred();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      return finalWrite.promise;
    },
  });
  const signal = trackedAbortSignal();
  let outcome: string | undefined;
  const flush = harness.coordinator.flush(
    1,
    snapshot("cancelled-success"),
    signal.signal,
  );
  void flush.then((result) => { outcome = result; });
  signal.abort();
  assert.equal(await flush, "cancelled");
  assert.equal(signal.listenerCount(), 0);

  finalWrite.resolve();
  await flushPromises();
  assert.equal(outcome, "cancelled");
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.blocked, []);

  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(value.sessionOrder?.[0] ?? "missing");
      return resumed.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("resumed-success"));
  harness.scheduler.fire(harness.scheduler.tasks[0]);
  assert.deepEqual(writes, [
    "session-cancelled-success",
    "session-resumed-success",
  ]);
  resumed.resolve();
  await flushPromises();
});

test("aborting an in-flight final preserves normal exact retry after an ambiguous failure", async () => {
  const harness = coordinatorHarness();
  const first = deferred<string>();
  const exact = deferred<string>();
  const latest = deferred<string>();
  const responses = [first, exact, latest];
  const writes: Array<{ revision: string; session: string }> = [];
  let expectedRevision = "revision-0";
  let active = 0;
  let maxActive = 0;
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      writes.push({
        revision: expectedRevision,
        session: value.sessionOrder?.[0] ?? "missing",
      });
      const response = responses.shift();
      assert.ok(response);
      try {
        expectedRevision = await response.promise;
      } finally {
        active -= 1;
      }
    },
  });
  const signal = trackedAbortSignal();
  const flush = harness.coordinator.flush(
    1,
    snapshot("cancelled-ambiguous"),
    signal.signal,
  );
  signal.abort();
  assert.equal(await flush, "cancelled");
  assert.equal(signal.listenerCount(), 0);

  first.reject(new Error("late ambiguous final"));
  await flushPromises();
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.scheduler.tasks.length, 1);
  const backoff = harness.scheduler.tasks[0];
  assert.equal(backoff.delayMs, 3_000);

  harness.coordinator.enqueue(1, snapshot("latest-after-abort"));
  const debounce = harness.scheduler.tasks[1];
  harness.scheduler.fire(debounce);
  assert.equal(writes.length, 1);
  harness.scheduler.fire(backoff);
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-cancelled-ambiguous" },
    { revision: "revision-0", session: "session-cancelled-ambiguous" },
  ]);
  assert.equal(maxActive, 1);

  exact.resolve("revision-1");
  await flushPromises();
  assert.deepEqual(writes, [
    { revision: "revision-0", session: "session-cancelled-ambiguous" },
    { revision: "revision-0", session: "session-cancelled-ambiguous" },
    { revision: "revision-1", session: "session-latest-after-abort" },
  ]);
  assert.equal(maxActive, 1);
  latest.resolve("revision-2");
  await flushPromises();
  assert.equal(harness.recovered(), 1);
  assert.deepEqual(harness.blocked, []);
  assert.equal(maxActive, 1);
});

test("block stop and newer attempts cancel flush while late settles stay fenced", async () => {
  for (const cancellation of ["block", "stop", "begin"] as const) {
    const harness = coordinatorHarness();
    const oldWrite = deferred();
    const writes: string[] = [];
    harness.coordinator.beginAttempt(1);
    harness.coordinator.authorize({
      attempt: 1,
      classifyFailure: () => "retry",
      write: (value) => {
        writes.push(value.sessionOrder?.[0] ?? "missing");
        return oldWrite.promise;
      },
    });
    const signal = trackedAbortSignal();
    const flush = harness.coordinator.flush(
      1,
      snapshot(`${cancellation}-final`),
      signal.signal,
    );
    assert.equal(signal.listenerCount(), 1);
    if (cancellation === "block") harness.coordinator.block(1);
    else if (cancellation === "stop") harness.coordinator.stop();
    else harness.coordinator.beginAttempt(2);
    assert.equal(await flush, "cancelled");
    assert.equal(signal.listenerCount(), 0);

    oldWrite.reject(new Error("late old failure"));
    await flushPromises();
    assert.deepEqual(harness.errors, []);
    assert.deepEqual(harness.blocked, []);
    if (cancellation === "begin") {
      harness.coordinator.authorize({
        attempt: 2,
        classifyFailure: () => "retry",
        write: async (value) => {
          writes.push(value.sessionOrder?.[0] ?? "missing");
        },
      });
      harness.coordinator.enqueue(2, snapshot("new-attempt"));
      harness.scheduler.fire(harness.scheduler.tasks.at(-1)!);
      await flushPromises();
      assert.deepEqual(writes, [
        `session-${cancellation}-final`,
        "session-new-attempt",
      ]);
    }
  }
});

test("a completed flush releases finalizing for reauthorization and later enqueue", async () => {
  const harness = coordinatorHarness();
  const first = deferred();
  const second = deferred();
  const writes: string[] = [];
  harness.coordinator.beginAttempt(1);
  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(`first:${value.sessionOrder?.[0] ?? "missing"}`);
      return first.promise;
    },
  });
  const flush = harness.coordinator.flush(
    1,
    snapshot("close-final"),
    new AbortController().signal,
  );
  first.resolve();
  assert.equal(await flush, "flushed");

  harness.coordinator.authorize({
    attempt: 1,
    classifyFailure: () => "retry",
    write: (value) => {
      writes.push(`second:${value.sessionOrder?.[0] ?? "missing"}`);
      return second.promise;
    },
  });
  harness.coordinator.enqueue(1, snapshot("after-flush"));
  const debounce = harness.scheduler.tasks.at(-1)!;
  assert.equal(debounce.delayMs, 500);
  harness.scheduler.fire(debounce);
  assert.deepEqual(writes, [
    "first:session-close-final",
    "second:session-after-flush",
  ]);
  second.resolve();
  await flushPromises();
});
