import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

type Effect = {
  kind: "layout" | "passive";
  callback: () => void | (() => void);
  dependencies: unknown[];
  cleanup?: () => void;
};

function sameDependencies(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

test("an aborted polling render cannot publish its task before layout commit", async () => {
  const refs: Array<{ current: unknown } | undefined> = [];
  const committed = new Map<number, Effect>();
  let pending = new Map<number, Effect>();
  let cursor = 0;
  let controllerTask: (() => void | Promise<void>) | null = null;
  let starts = 0;
  let stops = 0;
  class FakePollingController {
    constructor(options: { task(): void | Promise<void> }) {
      controllerTask = options.task;
    }
    start() {
      starts += 1;
    }
    stop() {
      stops += 1;
    }
  }
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useVisibilityAwarePolling.ts", import.meta.url),
    "utf8",
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: "useVisibilityAwarePolling.ts",
  });
  const react = {
    useRef(initial: unknown) {
      const index = cursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useLayoutEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pending.set(cursor++, { kind: "layout", callback, dependencies });
    },
    useEffect(callback: Effect["callback"], dependencies: unknown[]) {
      pending.set(cursor++, { kind: "passive", callback, dependencies });
    },
  };
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "exports", "module", output.outputText)(
    (specifier: string) => {
      if (specifier === "react") return react;
      if (specifier === "./pollingController") return { PollingController: FakePollingController };
      assert.fail(`unexpected module ${specifier}`);
    },
    module.exports,
    module,
  );
  const useVisibilityAwarePolling = module.exports.useVisibilityAwarePolling as (
    task: () => void | Promise<void>,
    options: { visibleIntervalMs: number; hiddenIntervalMs: number },
  ) => void;

  const render = (task: () => void | Promise<void>) => {
    cursor = 0;
    pending = new Map();
    useVisibilityAwarePolling(task, { visibleIntervalMs: 2_000, hiddenIntervalMs: 10_000 });
    const rendered = pending;
    const commitKind = (kind: Effect["kind"]) => {
      for (const [index, next] of rendered) {
        if (next.kind !== kind) continue;
        const previous = committed.get(index);
        if (previous && sameDependencies(previous.dependencies, next.dependencies)) continue;
        previous?.cleanup?.();
        const cleanup = next.callback();
        committed.set(index, {
          ...next,
          ...(typeof cleanup === "function" ? { cleanup } : {}),
        });
      }
    };
    return {
      abort() {
        if (pending === rendered) pending = new Map();
      },
      commitLayout: () => commitKind("layout"),
      commitPassive: () => commitKind("passive"),
    };
  };

  const calls: string[] = [];
  const runControllerTask = async () => {
    const task = controllerTask as (() => void | Promise<void>) | null;
    assert.ok(task);
    await task();
  };
  const initial = render(() => { calls.push("A"); });
  initial.commitLayout();
  initial.commitPassive();
  assert.equal(starts, 1);
  await runControllerTask();
  assert.deepEqual(calls, ["A"]);

  const aborted = render(() => { calls.push("B-aborted"); });
  aborted.abort();
  await runControllerTask();
  assert.deepEqual(calls, ["A", "A"]);

  const committedB = render(() => { calls.push("B"); });
  committedB.commitLayout();
  committedB.commitPassive();
  await runControllerTask();
  assert.deepEqual(calls, ["A", "A", "B"]);
  assert.equal(starts, 1, "task commits must not restart the passive polling controller");
  assert.equal(stops, 0);
});
