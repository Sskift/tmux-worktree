import assert from "node:assert/strict";
import test from "node:test";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "../src/latestRequestGate.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("latest request gate rejects a late result from another host with the same path", async () => {
  const gate = createLatestRequestGate();
  const hostA = deferred<string>();
  const hostB = deferred<string>();
  const published: string[] = [];
  const path = "/srv/repo/src/App.tsx";

  const publish = async (sourceKey: string, value: Promise<string>) => {
    const request = gate.issue(sourceKey);
    const result = await value;
    if (gate.isCurrent(request)) published.push(result);
  };

  const requestA = publish(requestSourceKey("host-a", path), hostA.promise);
  const requestB = publish(requestSourceKey("host-b", path), hostB.promise);
  hostB.resolve("host-b content");
  await requestB;
  hostA.resolve("host-a content");
  await requestA;

  assert.deepEqual(published, ["host-b content"]);
});

test("source keys distinguish host, path, cwd, query, and mode without delimiter collisions", () => {
  assert.notEqual(
    requestSourceKey("host-a", "/repo/file"),
    requestSourceKey("host-b", "/repo/file"),
  );
  assert.notEqual(
    requestSourceKey("host-a", "/repo/file"),
    requestSourceKey("host-a", "/other/file"),
  );
  assert.notEqual(
    requestSourceKey("host-a", "/repo", "needle", "content"),
    requestSourceKey("host-a", "/repo", "needle", "filename"),
  );
  assert.notEqual(
    requestSourceKey("a\u0000b", "c"),
    requestSourceKey("a", "b\u0000c"),
  );
});

test("issuing a debounced search identity invalidates the previous query before it resolves", async () => {
  const gate = createLatestRequestGate();
  const oldSearch = deferred<string[]>();
  const nextSearch = deferred<string[]>();
  const published: string[][] = [];

  const run = async (query: string, mode: string, value: Promise<string[]>) => {
    // FileTree issues here when the debounce is scheduled, not 300 ms later
    // when the backend request starts.
    const request = gate.issue(requestSourceKey("host-a", "/repo", query, mode));
    const results = await value;
    if (gate.isCurrent(request)) published.push(results);
  };

  const oldRun = run("old", "content", oldSearch.promise);
  const nextRun = run("next", "filename", nextSearch.promise);
  oldSearch.resolve(["stale"]);
  await oldRun;
  nextSearch.resolve(["current"]);
  await nextRun;

  assert.deepEqual(published, [["current"]]);
});
