import assert from "node:assert/strict";
import test from "node:test";
import type { PlainTerminal } from "../src/platform/domainTypes.ts";
import { createFakeDashboardBackend } from "../src/platform/fakeBackend.ts";
import {
  mergeRestoredTerminalMetadata,
  restorePersistedTerminalMetadata,
} from "../src/terminalPersistence.ts";

function terminal(
  id: string,
  overrides: Partial<PlainTerminal> = {},
): PlainTerminal {
  return {
    id,
    label: id,
    cwd: `/repo/${id}`,
    tmuxName: id,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, reject, resolve };
}

test("terminal metadata restore filters, normalizes, and preserves managed and legacy semantics", async () => {
  const ensureArgs: unknown[] = [];
  const { backend, transport } = createFakeDashboardBackend({
    tmux_session_exists: (input) => {
      const { name } = input as { name: string };
      if (name === "managed-drop") return false;
      if (name === "managed-reject") throw new Error("ssh unavailable");
      return true;
    },
    ensure_terminal_session: (input) => {
      const { args } = input as { args: unknown };
      ensureArgs.push(args);
      if ((args as { name: string }).name === "legacy-failure") {
        throw new Error("tmux unavailable");
      }
    },
  });
  const saved = [
    terminal("filtered", { tmuxName: "" }),
    terminal("managed-keep", {
      label: "tw-term-managed",
      cwd: "/repo/kept",
      tmuxName: "managed-keep",
      hostId: "local",
      managed: true,
    }),
    terminal("managed-drop", { tmuxName: "managed-drop", managed: true }),
    terminal("managed-reject", { tmuxName: "managed-reject", managed: true }),
    terminal("legacy-success", {
      tmuxName: "build:legacy-success",
      hostId: "build",
      aiCmd: "codex",
      managed: false,
    }),
    terminal("legacy-failure", {
      tmuxName: "legacy-failure",
      aiCmd: undefined,
      managed: undefined,
    }),
  ];

  const restored = await restorePersistedTerminalMetadata(saved, backend);

  assert.deepEqual(restored.map(({ id }) => id), [
    "managed-keep",
    "managed-reject",
    "legacy-success",
    "legacy-failure",
  ]);
  assert.deepEqual(restored[0], {
    ...saved[1],
    hostId: null,
    rawName: "managed-keep",
    label: "kept",
  });
  assert.deepEqual(restored[2], {
    ...saved[4],
    hostId: "build",
    rawName: "legacy-success",
    label: "legacy-success",
  });
  assert.deepEqual(restored[3], {
    ...saved[5],
    hostId: null,
    rawName: "legacy-failure",
    label: "legacy-failure",
  });
  assert.deepEqual(ensureArgs, [
    {
      name: "build:legacy-success",
      cwd: "/repo/legacy-success",
      aiCmd: "codex",
      hostId: "build",
      rawName: "legacy-success",
    },
    {
      name: "legacy-failure",
      cwd: "/repo/legacy-failure",
      aiCmd: "",
      hostId: null,
      rawName: "legacy-failure",
    },
  ]);
  assert.deepEqual(
    transport.calls.filter(({ command }) => command === "tmux_session_exists")
      .map(({ args }) => args),
    [
      { name: "managed-keep" },
      { name: "managed-drop" },
      { name: "managed-reject" },
    ],
  );
  assert.equal(
    transport.calls.filter(({ command }) => command === "ensure_terminal_session").length,
    2,
    "managed metadata must never use the legacy ensure path",
  );
});

test("terminal metadata restore keeps input order when managed probes finish out of order", async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const { backend } = createFakeDashboardBackend({
    tmux_session_exists: (input) => {
      const { name } = input as { name: string };
      return name === "first" ? first.promise : second.promise;
    },
  });
  const pending = restorePersistedTerminalMetadata([
    terminal("first", { managed: true }),
    terminal("second", { managed: true }),
  ], backend);

  second.resolve(true);
  first.resolve(true);

  assert.deepEqual((await pending).map(({ id }) => id), ["first", "second"]);
});

test("restored metadata publishes first while retaining concurrent unique additions", () => {
  const current = [
    terminal("concurrent-duplicate", {
      tmuxName: "build:tw-term-shared",
      hostId: "build",
      rawName: "tw-term-shared",
    }),
    terminal("concurrent-new", { tmuxName: "tw-term-new" }),
  ];
  const restored = [
    terminal("restored", {
      tmuxName: "build:tw-term-shared",
      hostId: "build",
      rawName: "tw-term-shared",
    }),
  ];
  const currentBefore = structuredClone(current);
  const restoredBefore = structuredClone(restored);

  const merged = mergeRestoredTerminalMetadata(current, restored);

  assert.deepEqual(merged.map(({ id }) => id), ["restored", "concurrent-new"]);
  assert.deepEqual(current, currentBefore);
  assert.deepEqual(restored, restoredBefore);
  assert.notEqual(merged, current);
  assert.notEqual(merged, restored);
});
