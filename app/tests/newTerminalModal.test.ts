import assert from "node:assert/strict";
import test from "node:test";
import {
  createLatestRequestGate,
  requestSourceKey,
} from "../src/latestRequestGate.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

test("new terminal rejects a delayed home default after a source change or user edit", async () => {
  for (const replacement of [
    { path: "/remote/repo", label: "remote", source: "host-a" },
    { path: "/Users/me/custom", label: "custom", source: "local-edit" },
  ]) {
    const gate = createLatestRequestGate();
    const home = deferred<string>();
    const token = gate.issue(
      requestSourceKey("new-terminal-home-directory", "__local__"),
    );
    let path = "";
    let label = "";
    const publication = home.promise.then((directory) => {
      if (!gate.isCurrent(token)) return;
      path = `${directory}/Desktop`;
      label = "Desktop";
    });

    gate.invalidate();
    path = replacement.path;
    label = replacement.label;
    home.resolve("/Users/me");
    await publication;

    assert.deepEqual(
      { path, label },
      { path: replacement.path, label: replacement.label },
      replacement.source,
    );
  }
});
