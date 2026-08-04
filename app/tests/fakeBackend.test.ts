import assert from "node:assert/strict";
import test from "node:test";
const {
  createFakeDashboardBackend,
  FakeDashboardTransport,
} = await import("../src/platform/fakeBackend.ts");

test("FakeDashboardTransport records calls and runs sync or async handlers", async () => {
  const transport = new FakeDashboardTransport({
    sync: (args) => ({ args, kind: "sync" }),
    async: async (args) => ({ args, kind: "async" }),
  });

  assert.deepEqual(await transport.invoke("sync", { value: 1 }), {
    args: { value: 1 },
    kind: "sync",
  });
  assert.deepEqual(await transport.invoke("async", { value: 2 }), {
    args: { value: 2 },
    kind: "async",
  });
  assert.deepEqual(transport.calls, [
    { command: "sync", args: { value: 1 } },
    { command: "async", args: { value: 2 } },
  ]);
});

test("FakeDashboardTransport reports missing commands", async () => {
  const transport = new FakeDashboardTransport();

  await assert.rejects(
    transport.invoke("missing_command"),
    /fake backend command not implemented: missing_command/,
  );
  assert.deepEqual(transport.calls, [{ command: "missing_command", args: undefined }]);
});

test("FakeDashboardTransport emits to every listener and unsubscribe is idempotent", async () => {
  const transport = new FakeDashboardTransport();
  const received: string[] = [];
  const first = await transport.listen<{ value: string }>("status", (payload) => {
    received.push(`first:${payload.value}`);
  });
  const second = await transport.listen<{ value: string }>("status", (payload) => {
    received.push(`second:${payload.value}`);
  });

  assert.equal(transport.listenerCount("status"), 2);
  transport.emit("status", { value: "ready" });
  assert.deepEqual(received, ["first:ready", "second:ready"]);

  first();
  first();
  assert.equal(transport.listenerCount("status"), 1);
  transport.emit("status", { value: "updated" });
  assert.deepEqual(received, ["first:ready", "second:ready", "second:updated"]);

  second();
  assert.equal(transport.listenerCount("status"), 0);
  transport.emit("status", { value: "ignored" });
  assert.deepEqual(received, ["first:ready", "second:ready", "second:updated"]);
});

test("FakeDashboardTransport keeps event channels isolated", async () => {
  const transport = new FakeDashboardTransport();
  const received: string[] = [];
  await transport.listen<string>("one", (payload) => { received.push(`one:${payload}`); });
  await transport.listen<string>("two", (payload) => { received.push(`two:${payload}`); });

  transport.emit("one", "payload");

  assert.deepEqual(received, ["one:payload"]);
  assert.equal(transport.listenerCount("one"), 1);
  assert.equal(transport.listenerCount("two"), 1);
});

test("fake events offer deterministic async dispatch for component tests", async () => {
  const transport = new FakeDashboardTransport();
  const received: string[] = [];
  await transport.listen<string>("async", async (payload) => {
    await Promise.resolve();
    received.push(payload);
  });

  await transport.emitAsync("async", "ready");

  assert.deepEqual(received, ["ready"]);
});

test("fake assets are deterministic and preserve the entire path", () => {
  const { backend, transport } = createFakeDashboardBackend();
  const path = "/tmp/Dashboard icon #1.png";

  assert.equal(
    transport.assetUrl(path),
    "fake-asset://%2Ftmp%2FDashboard%20icon%20%231.png",
  );
  assert.equal(backend.files.assetUrl(path), transport.assetUrl(path));
});

test("fake directory dialogs return their configured selection or cancellation", async () => {
  const { backend, transport } = createFakeDashboardBackend();
  transport.selectedDirectory = "/repo/dashboard";

  assert.equal(
    await backend.dialog.selectDirectory({ title: "Choose a repository" }),
    "/repo/dashboard",
  );

  transport.selectedDirectory = null;
  assert.equal(
    await backend.dialog.selectDirectory({ title: "Choose a repository" }),
    null,
  );

  transport.confirmationResult = false;
  assert.equal(
    await backend.dialog.confirm({ title: "Delete", message: "Delete this worktree?" }),
    false,
  );
});

test("fake window state is observable and logical size updates in place", async () => {
  const { backend, transport } = createFakeDashboardBackend();
  const window = backend.window.current();

  assert.equal("closeLifecycle" in transport, false);
  assert.equal("closeLifecycle" in backend.window, false);
  assert.equal(window, transport.window);
  assert.equal(await window.isFullscreen(), false);
  assert.equal(await window.isMaximized(), false);
  assert.deepEqual(await window.innerSize(), { width: 1440, height: 900 });
  assert.deepEqual(await window.outerPosition(), { x: 0, y: 0 });
  assert.equal(await window.scaleFactor(), 1);

  transport.window.fullscreen = true;
  transport.window.maximized = true;
  transport.window.x = 48;
  transport.window.y = 72;
  transport.window.factor = 2;
  let resizeCount = 0;
  let moveCount = 0;
  const stopResize = await window.onResized(() => { resizeCount += 1; });
  const stopMove = await window.onMoved(() => { moveCount += 1; });
  await window.setLogicalSize(960, 640);

  assert.equal(await window.isFullscreen(), true);
  assert.equal(await window.isMaximized(), true);
  assert.deepEqual(await window.innerSize(), { width: 1920, height: 1280 });
  assert.deepEqual(await window.outerPosition(), { x: 48, y: 72 });
  assert.equal(await window.scaleFactor(), 2);

  assert.equal(transport.window.listenerCount("resized"), 1);
  assert.equal(transport.window.listenerCount("moved"), 1);
  assert.equal(resizeCount, 1);
  transport.window.emitResized();
  transport.window.emitMoved();
  assert.equal(resizeCount, 2);
  assert.equal(moveCount, 1);

  stopResize();
  stopMove();
  assert.equal(transport.window.listenerCount("resized"), 0);
  assert.equal(transport.window.listenerCount("moved"), 0);
});
