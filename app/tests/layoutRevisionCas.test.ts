import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDashboardLayoutPersistenceFailure,
  isDashboardLayoutPersistenceError,
  isDashboardLayoutRevision,
  loadDashboardLayoutPreferences,
  saveDashboardLayoutPreferences,
} from "../src/dashboard/layoutPersistence.ts";
import { DEFAULT_COLUMN_ORDER } from "../src/dashboard/layout/schema.ts";

const { createFakeDashboardBackend } = await import("../src/platform/fakeBackend.ts");

const INITIAL_REVISION = "twlr1_sXxMImuzfZTgkc_67MCwlyAPnRg6pgLHfSRIUVhE-nY";
const NEXT_REVISION = "twlr1_HfyBm0VsDGpTixmc8n6KpBqTiqpSf26rY03Pph07iM8";
const CURRENT_LAYOUT = {
  schemaVersion: 2,
  columnOrder: [...DEFAULT_COLUMN_ORDER],
  sidebarWidth: 280,
};

function assertProtocolFailure(error: unknown): boolean {
  assert.equal(isDashboardLayoutPersistenceError(error), true);
  assert.equal(classifyDashboardLayoutPersistenceFailure(error), "block");
  const record = error as Record<string, unknown>;
  assert.deepEqual(Reflect.ownKeys(record).sort(), ["code", "message", "retryable"]);
  assert.equal(record.code, "LAYOUT_INVALID_REQUEST");
  assert.equal(record.retryable, false);
  return true;
}

test("layout persistence accepts strict load/save envelopes and forwards exact CAS payload", async () => {
  const { backend, transport } = createFakeDashboardBackend({
    load_layout: () => ({ layout: CURRENT_LAYOUT, revision: INITIAL_REVISION }),
    save_layout: () => ({ revision: NEXT_REVISION, unchanged: false }),
  });

  const loaded = await loadDashboardLayoutPreferences(backend);
  assert.equal(loaded.kind, "compatible");
  assert.equal(loaded.revision, INITIAL_REVISION);
  assert.ok(loaded.kind === "compatible");
  const saved = await saveDashboardLayoutPreferences(
    backend,
    { ...loaded.layout, sidebarWidth: 320 },
    loaded.revision,
    loaded.extensions,
  );
  assert.deepEqual(saved, { revision: NEXT_REVISION, unchanged: false });
  assert.deepEqual(transport.calls[0], { command: "load_layout", args: undefined });
  assert.equal(transport.calls[1]?.command, "save_layout");
  const saveArgs = transport.calls[1]?.args as {
    layout: Record<string, unknown>;
    expectedRevision: string;
  };
  assert.equal(saveArgs.expectedRevision, INITIAL_REVISION);
  assert.deepEqual({ ...saveArgs.layout }, {
    schemaVersion: 2,
    columnOrder: [...DEFAULT_COLUMN_ORDER],
    sidebarWidth: 320,
  });
});

test("load envelope validation rejects legacy and malformed shapes without invoking accessors", async () => {
  const invalidEnvelopes: unknown[] = [
    CURRENT_LAYOUT,
    { layout: CURRENT_LAYOUT },
    { layout: CURRENT_LAYOUT, revision: "twlr1_short" },
    { layout: CURRENT_LAYOUT, revision: INITIAL_REVISION, extra: true },
    null,
    [],
  ];
  for (const envelope of invalidEnvelopes) {
    const { backend } = createFakeDashboardBackend({ load_layout: () => envelope });
    await assert.rejects(loadDashboardLayoutPreferences(backend), assertProtocolFailure);
  }

  let getterReads = 0;
  const accessorEnvelope = { layout: CURRENT_LAYOUT } as Record<string, unknown>;
  Object.defineProperty(accessorEnvelope, "revision", {
    enumerable: true,
    get() {
      getterReads += 1;
      return INITIAL_REVISION;
    },
  });
  const { backend: accessorBackend } = createFakeDashboardBackend({
    load_layout: () => accessorEnvelope,
  });
  await assert.rejects(
    loadDashboardLayoutPreferences(accessorBackend),
    assertProtocolFailure,
  );
  assert.equal(getterReads, 0);

  let proxyReads = 0;
  const proxyEnvelope = new Proxy(
    { layout: CURRENT_LAYOUT, revision: INITIAL_REVISION },
      {
        get(target, property, receiver) {
          if (property === "then") return undefined;
          proxyReads += 1;
          return Reflect.get(target, property, receiver);
      },
    },
  );
  const { backend: proxyBackend } = createFakeDashboardBackend({
    load_layout: () => proxyEnvelope,
  });
  assert.equal((await loadDashboardLayoutPreferences(proxyBackend)).revision, INITIAL_REVISION);
  assert.equal(proxyReads, 0);
});

test("save protocol failures are own nonretryable errors and never become blind retries", async () => {
  {
    const { backend, transport } = createFakeDashboardBackend({
      save_layout: () => assert.fail("invalid expected revision must not reach transport"),
    });
    await assert.rejects(
      saveDashboardLayoutPreferences(backend, CURRENT_LAYOUT, "invalid"),
      assertProtocolFailure,
    );
    assert.deepEqual(transport.calls, []);
  }

  for (const response of [
    undefined,
    {},
    { revision: NEXT_REVISION },
    { revision: "twlr1_bad", unchanged: false },
    { revision: NEXT_REVISION, unchanged: "false" },
    { revision: NEXT_REVISION, unchanged: false, extra: true },
  ]) {
    const { backend } = createFakeDashboardBackend({ save_layout: () => response });
    await assert.rejects(
      saveDashboardLayoutPreferences(backend, CURRENT_LAYOUT, INITIAL_REVISION),
      assertProtocolFailure,
    );
  }
});

test("revision and retryability guards are strict, own-data, and forward compatible", () => {
  assert.equal(isDashboardLayoutRevision(INITIAL_REVISION), true);
  for (const revision of [
    `twlr1_${"a".repeat(42)}`,
    `twlr1_${"a".repeat(44)}`,
    `twlr1_${"a".repeat(42)}=`,
    `twlr2_${"a".repeat(43)}`,
  ]) {
    assert.equal(isDashboardLayoutRevision(revision), false);
  }

  const futureFailure = {
    code: "LAYOUT_FUTURE_NON_RETRYABLE_CODE",
    message: "future native error",
    retryable: false,
  };
  assert.equal(isDashboardLayoutPersistenceError(futureFailure), false);
  assert.equal(classifyDashboardLayoutPersistenceFailure(futureFailure), "block");
  assert.equal(
    classifyDashboardLayoutPersistenceFailure(Object.create({ retryable: false })),
    "block",
  );

  let getterReads = 0;
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "retryable", {
    enumerable: true,
    get() {
      getterReads += 1;
      return false;
    },
  });
  assert.equal(classifyDashboardLayoutPersistenceFailure(accessor), "block");
  assert.equal(getterReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(
    { retryable: false },
    {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.equal(classifyDashboardLayoutPersistenceFailure(proxy), "block");
  assert.equal(proxyReads, 0);

  const validMatrix = [
    {
      error: { code: "LAYOUT_IO_ERROR", message: "io", retryable: true },
      classification: "retry",
    },
    {
      error: {
        code: "LAYOUT_REVISION_CONFLICT",
        message: "conflict",
        retryable: false,
        currentRevision: NEXT_REVISION,
      },
      classification: "block",
    },
    {
      error: {
        code: "LAYOUT_STATE_BLOCKED",
        message: "blocked",
        retryable: false,
        currentRevision: NEXT_REVISION,
      },
      classification: "block",
    },
    {
      error: {
        code: "LAYOUT_INVALID_REQUEST",
        message: "invalid",
        retryable: false,
      },
      classification: "block",
    },
  ] as const;
  for (const { error, classification } of validMatrix) {
    assert.equal(isDashboardLayoutPersistenceError(error), true);
    assert.equal(classifyDashboardLayoutPersistenceFailure(error), classification);
  }

  for (const contradictory of [
    { code: "LAYOUT_IO_ERROR", message: "io", retryable: false },
    {
      code: "LAYOUT_IO_ERROR",
      message: "io",
      retryable: true,
      currentRevision: NEXT_REVISION,
    },
    { code: "LAYOUT_REVISION_CONFLICT", message: "conflict", retryable: false },
    {
      code: "LAYOUT_STATE_BLOCKED",
      message: "blocked",
      retryable: true,
      currentRevision: NEXT_REVISION,
    },
    {
      code: "LAYOUT_INVALID_REQUEST",
      message: "invalid",
      retryable: false,
      currentRevision: NEXT_REVISION,
    },
    { code: "LAYOUT_UNKNOWN", message: "unknown", retryable: true },
  ]) {
    assert.equal(isDashboardLayoutPersistenceError(contradictory), false);
    assert.equal(classifyDashboardLayoutPersistenceFailure(contradictory), "block");
  }

  const trappedProxy = new Proxy(
    { code: "LAYOUT_IO_ERROR", message: "io", retryable: true },
    { ownKeys: () => { throw new Error("proxy ownKeys"); } },
  );
  assert.equal(classifyDashboardLayoutPersistenceFailure(trappedProxy), "block");

  let validProxyReads = 0;
  const validIoProxy = new Proxy(
    { code: "LAYOUT_IO_ERROR", message: "offline", retryable: true },
    {
      get(target, property, receiver) {
        validProxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  assert.equal(classifyDashboardLayoutPersistenceFailure(validIoProxy), "retry");
  assert.equal(validProxyReads, 0);
});
