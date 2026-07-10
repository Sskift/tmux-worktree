import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardBackend } from "../src/platform/dashboardBackend.ts";
import type {
  BackendEventHandler,
  DashboardTransport,
  DashboardWindow,
  DirectoryDialogOptions,
  PtyOpenArgs,
} from "../src/platform/types.ts";

type InvokeHandler = (args?: unknown) => unknown | Promise<unknown>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const unusedWindow: DashboardWindow = {
  isFullscreen: async () => false,
  isMaximized: async () => false,
  innerSize: async () => ({ width: 1440, height: 900 }),
  outerPosition: async () => ({ x: 0, y: 0 }),
  scaleFactor: async () => 1,
  setLogicalSize: async () => {},
  onResized: async () => () => {},
  onMoved: async () => () => {},
};

class InstrumentedPtyTransport implements DashboardTransport {
  readonly calls: Array<{ command: string; args?: unknown }> = [];
  readonly order: string[] = [];
  readonly handlers = new Map<string, InvokeHandler>();
  readonly listenErrors = new Map<string, unknown>();
  readonly listenGates = new Map<string, Promise<void>>();
  readonly unlistenCalls = new Map<string, number>();
  private readonly listeners = new Map<string, Set<BackendEventHandler<unknown>>>();

  async invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    this.order.push(`invoke:${command}`);
    const handler = this.handlers.get(command);
    return await handler?.(args) as T;
  }

  async listen<T>(event: string, handler: BackendEventHandler<T>) {
    this.order.push(`listen:${event}`);
    if (this.listenErrors.has(event)) throw this.listenErrors.get(event);
    await this.listenGates.get(event);
    const listeners = this.listeners.get(event) ?? new Set<BackendEventHandler<unknown>>();
    const unknownHandler = handler as BackendEventHandler<unknown>;
    listeners.add(unknownHandler);
    this.listeners.set(event, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unlistenCalls.set(event, (this.unlistenCalls.get(event) ?? 0) + 1);
      listeners.delete(unknownHandler);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }

  async emit<T>(event: string, payload: T): Promise<void> {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      await handler(payload);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  assetUrl(path: string): string {
    return path;
  }

  async selectDirectory(_options: DirectoryDialogOptions): Promise<string | null> {
    return null;
  }

  async confirm(): Promise<boolean> {
    return true;
  }

  currentWindow(): DashboardWindow {
    return unusedWindow;
  }
}

const ptyArgs: PtyOpenArgs = {
  id: "pty-test",
  cmd: "/bin/zsh",
  args: ["-l"],
  cwd: "/repo/dashboard",
  cols: 120,
  rows: 40,
};

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail("condition was not reached");
}

test("PTY subscribes to data and exit before opening and receives data emitted during open", async () => {
  const transport = new InstrumentedPtyTransport();
  const received: string[] = [];
  transport.handlers.set("pty_open", async () => {
    await transport.emit(`pty:${ptyArgs.id}`, { id: ptyArgs.id, data: "early output" });
    return ptyArgs.id;
  });
  const backend = createDashboardBackend(transport);

  const connection = await backend.pty.connect(ptyArgs, {
    onData: (event) => {
      received.push(event.data);
      transport.order.push(`data:${event.data}`);
    },
    onExit: () => {},
  });

  assert.deepEqual(transport.order.slice(0, 4), [
    `listen:pty:${ptyArgs.id}`,
    `listen:pty-exit:${ptyArgs.id}`,
    "invoke:pty_open",
    "data:early output",
  ]);
  assert.deepEqual(transport.calls[0], {
    command: "pty_open",
    args: { args: ptyArgs },
  });
  assert.deepEqual(received, ["early output"]);
  assert.equal(connection.active, true);
  await connection.close();
});

test("PTY ignores data events whose payload id does not match the channel", async () => {
  const transport = new InstrumentedPtyTransport();
  const received: string[] = [];
  transport.handlers.set("pty_open", async () => {
    await transport.emit(`pty:${ptyArgs.id}`, { id: "another-pty", data: "wrong" });
    await transport.emit(`pty:${ptyArgs.id}`, { id: ptyArgs.id, data: "right" });
    return ptyArgs.id;
  });
  const backend = createDashboardBackend(transport);

  const connection = await backend.pty.connect(ptyArgs, {
    onData: (event) => received.push(event.data),
    onExit: () => {},
  });

  assert.deepEqual(received, ["right"]);
  await connection.close();
});

test("PTY cleans the first subscription when the exit subscription fails", async () => {
  const transport = new InstrumentedPtyTransport();
  const expected = new Error("exit listener unavailable");
  transport.listenErrors.set(`pty-exit:${ptyArgs.id}`, expected);
  const backend = createDashboardBackend(transport);

  await assert.rejects(
    backend.pty.connect(ptyArgs, { onData: () => {}, onExit: () => {} }),
    (error) => error === expected,
  );

  assert.deepEqual(transport.order, [
    `listen:pty:${ptyArgs.id}`,
    `listen:pty-exit:${ptyArgs.id}`,
  ]);
  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  assert.equal(transport.unlistenCalls.get(`pty:${ptyArgs.id}`), 1);
  assert.equal(transport.calls.length, 0);
});

test("PTY abort while the exit subscription is pending cleans every listener before open", async () => {
  const transport = new InstrumentedPtyTransport();
  const exitListen = deferred<void>();
  transport.listenGates.set(`pty-exit:${ptyArgs.id}`, exitListen.promise);
  const backend = createDashboardBackend(transport);
  const controller = new AbortController();

  const pending = backend.pty.connect(
    ptyArgs,
    { onData: () => {}, onExit: () => {} },
    controller.signal,
  );
  await waitUntil(() => transport.order.includes(`listen:pty-exit:${ptyArgs.id}`));
  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 1);

  controller.abort();
  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  exitListen.resolve();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  assert.equal(transport.calls.some((call) => call.command === "pty_open"), false);
});

test("PTY cleans both subscriptions and preserves an open failure", async () => {
  const transport = new InstrumentedPtyTransport();
  const expected = new Error("open failed");
  transport.handlers.set("pty_open", () => {
    throw expected;
  });
  const backend = createDashboardBackend(transport);

  await assert.rejects(
    backend.pty.connect(ptyArgs, { onData: () => {}, onExit: () => {} }),
    (error) => error === expected,
  );

  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  assert.equal(transport.unlistenCalls.get(`pty:${ptyArgs.id}`), 1);
  assert.equal(transport.unlistenCalls.get(`pty-exit:${ptyArgs.id}`), 1);
  assert.deepEqual(
    transport.calls.map((call) => call.command),
    ["pty_open"],
  );
});

test("PTY rejects an id mismatch, kills the mismatched process, and removes listeners", async () => {
  const transport = new InstrumentedPtyTransport();
  transport.handlers.set("pty_open", () => "different-id");
  const backend = createDashboardBackend(transport);

  await assert.rejects(
    backend.pty.connect(ptyArgs, { onData: () => {}, onExit: () => {} }),
    /pty id mismatch: expected pty-test, got different-id/,
  );

  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  assert.equal(transport.unlistenCalls.get(`pty:${ptyArgs.id}`), 1);
  assert.equal(transport.unlistenCalls.get(`pty-exit:${ptyArgs.id}`), 1);
  assert.deepEqual(
    transport.calls.filter((call) => call.command === "pty_kill"),
    [{ command: "pty_kill", args: { id: "different-id" } }],
  );
});

test("PTY abort during an in-flight open unsubscribes immediately and kills after open resolves", async () => {
  const transport = new InstrumentedPtyTransport();
  const open = deferred<string>();
  transport.handlers.set("pty_open", () => open.promise);
  const backend = createDashboardBackend(transport);
  const controller = new AbortController();

  const pending = backend.pty.connect(
    ptyArgs,
    { onData: () => {}, onExit: () => {} },
    controller.signal,
  );
  await waitUntil(() => transport.calls.some((call) => call.command === "pty_open"));

  controller.abort();
  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  open.resolve(ptyArgs.id);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.deepEqual(
    transport.calls.filter((call) => call.command === "pty_kill"),
    [{ command: "pty_kill", args: { id: ptyArgs.id } }],
  );
  assert.equal(transport.unlistenCalls.get(`pty:${ptyArgs.id}`), 1);
  assert.equal(transport.unlistenCalls.get(`pty-exit:${ptyArgs.id}`), 1);
});

test("PTY handles an exit emitted before open resolves without leaving an active connection", async () => {
  const transport = new InstrumentedPtyTransport();
  const exits: number[] = [];
  transport.handlers.set("pty_open", async () => {
    await transport.emit(`pty-exit:${ptyArgs.id}`, { id: ptyArgs.id, code: 17 });
    return ptyArgs.id;
  });
  const backend = createDashboardBackend(transport);

  const connection = await backend.pty.connect(ptyArgs, {
    onData: () => {},
    onExit: (event) => {
      exits.push(event.code);
    },
  });

  assert.deepEqual(exits, [17]);
  assert.equal(connection.active, false);
  assert.equal(transport.listenerCount(`pty:${ptyArgs.id}`), 0);
  assert.equal(transport.listenerCount(`pty-exit:${ptyArgs.id}`), 0);
  await connection.close();
  assert.equal(transport.calls.some((call) => call.command === "pty_kill"), false);
});

test("PTY close is idempotent and closed connections reject write and resize", async () => {
  const transport = new InstrumentedPtyTransport();
  transport.handlers.set("pty_open", () => ptyArgs.id);
  const backend = createDashboardBackend(transport);
  const connection = await backend.pty.connect(ptyArgs, {
    onData: () => {},
    onExit: () => {},
  });

  await Promise.all([connection.close(), connection.close()]);

  assert.equal(connection.active, false);
  assert.equal(transport.unlistenCalls.get(`pty:${ptyArgs.id}`), 1);
  assert.equal(transport.unlistenCalls.get(`pty-exit:${ptyArgs.id}`), 1);
  assert.deepEqual(
    transport.calls.filter((call) => call.command === "pty_kill"),
    [{ command: "pty_kill", args: { id: ptyArgs.id } }],
  );

  await assert.rejects(connection.write("ignored"), /PTY connection is closed/);
  await assert.rejects(connection.resize(80, 24), /PTY connection is closed/);
  assert.equal(transport.calls.some((call) => call.command === "pty_write"), false);
  assert.equal(transport.calls.some((call) => call.command === "pty_resize"), false);
});
