import assert from "node:assert/strict";
import test from "node:test";
import type { PlainTerminal } from "../src/platform/index.ts";
import {
  allocateTerminalId,
  createTerminalSaveCoordinator,
} from "../src/terminalPersistence.ts";

function terminal(id: string, label = id): PlainTerminal {
  return {
    id,
    label,
    cwd: "/repo",
    tmuxName: `tw-${id}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("new terminal IDs cannot reuse an unseen legacy sequential ID", () => {
  assert.equal(allocateTerminalId([], () => "fresh"), "term-v2-fresh");
  assert.notEqual(allocateTerminalId([], () => "fresh"), "term-1");
});

test("terminal ID allocation retries the negligible in-memory UUID collision", () => {
  const entropy = ["duplicate", "unique"];
  assert.equal(
    allocateTerminalId([terminal("term-v2-duplicate")], () => entropy.shift()!),
    "term-v2-unique",
  );
});

test("failed terminal metadata saves retry and publish recovery", async () => {
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const snapshots: string[][] = [];
  const errors: unknown[] = [];
  let saves = 0;
  let recoveries = 0;
  const coordinator = createTerminalSaveCoordinator({
    save: async (terminals) => {
      snapshots.push(terminals.map(({ id }) => id));
      saves += 1;
      if (saves === 1) throw new Error("disk busy");
    },
    schedule: (callback) => {
      const task = { callback, cancelled: false };
      scheduled.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    retryDelayMs: () => 3_000,
    onError: (error) => errors.push(error),
    onSaved: () => {
      recoveries += 1;
    },
  });

  coordinator.enqueue([terminal("term-v2-a")]);
  await nextTurn();

  assert.equal(errors.length, 1);
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  await nextTurn();

  assert.deepEqual(snapshots, [["term-v2-a"], ["term-v2-a"]]);
  assert.equal(recoveries, 1);
  coordinator.stop();
});

test("terminal metadata saves serialize and skip superseded pending snapshots", async () => {
  const firstSave = deferred<void>();
  const secondSave = deferred<void>();
  const snapshots: string[][] = [];
  const saves = [firstSave, secondSave];
  const coordinator = createTerminalSaveCoordinator({
    save: (terminals) => {
      snapshots.push(terminals.map(({ id }) => id));
      return saves[snapshots.length - 1].promise;
    },
    schedule: () => () => {},
    retryDelayMs: () => 3_000,
    onError: () => assert.fail("save should not fail"),
  });

  coordinator.enqueue([terminal("term-v2-a")]);
  coordinator.enqueue([terminal("term-v2-a"), terminal("term-v2-b")]);
  coordinator.enqueue([terminal("term-v2-a"), terminal("term-v2-c")]);

  assert.deepEqual(snapshots, [["term-v2-a"]]);
  firstSave.resolve();
  await nextTurn();
  assert.deepEqual(snapshots, [
    ["term-v2-a"],
    ["term-v2-a", "term-v2-c"],
  ]);

  secondSave.resolve();
  await nextTurn();
  coordinator.stop();
});

test("a failed stale save retries the newest queued terminal snapshot", async () => {
  const firstSave = deferred<void>();
  const scheduled: Array<() => void> = [];
  const snapshots: string[][] = [];
  const coordinator = createTerminalSaveCoordinator({
    save: (terminals) => {
      snapshots.push(terminals.map(({ id }) => id));
      return snapshots.length === 1 ? firstSave.promise : Promise.resolve();
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
    retryDelayMs: () => 3_000,
    onError: () => {},
  });

  coordinator.enqueue([terminal("term-v2-old")]);
  coordinator.enqueue([terminal("term-v2-new")]);
  firstSave.reject(new Error("temporary failure"));
  await nextTurn();

  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await nextTurn();
  assert.deepEqual(snapshots, [["term-v2-old"], ["term-v2-new"]]);
  coordinator.stop();
});
