import assert from "node:assert/strict";
import test from "node:test";

const nativeCell = await import(
  "../dist/relay/v2/hostCredentialAtomicFileCellNative.js"
);

const ABI_VERSION = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION;
const MAX_BYTES = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_MAX_BYTES;
const OPEN_METHOD = nativeCell.RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD;

function errorCode(code) {
  return (error) => error?.code === code;
}

function result(operation, outcome, fields = {}) {
  return { abiVersion: ABI_VERSION, operation, outcome, ...fields };
}

function current(revision, bytes) {
  return bytes === null
    ? { state: "empty", revision }
    : { state: "present", revision, bytes };
}

function createHarness(options = {}) {
  const state = {
    bytes: options.bytes === undefined ? null : Uint8Array.from(options.bytes),
    generation: 0,
    openCalls: 0,
    readCalls: 0,
    compareCalls: 0,
    closeCalls: 0,
    readOverride: null,
    compareOverride: null,
    closeOverride: null,
    onCompare: null,
  };
  const revisions = new WeakMap();
  const issueCurrent = () => {
    const revision = Object.freeze(Object.create(null));
    revisions.set(revision, state.generation);
    return current(revision, state.bytes);
  };
  const handle = Object.freeze({
    read(request) {
      state.readCalls += 1;
      assert.equal(request.abiVersion, ABI_VERSION);
      assert.equal(request.operation, "read");
      if (typeof state.readOverride === "function") return state.readOverride(request);
      return result("read", "ok", { current: issueCurrent() });
    },
    compareAndSwap(request) {
      state.compareCalls += 1;
      assert.equal(request.abiVersion, ABI_VERSION);
      assert.equal(request.operation, "compare_and_swap");
      state.onCompare?.(request);
      if (typeof state.compareOverride === "function") return state.compareOverride(request);
      if (revisions.get(request.revision) !== state.generation) {
        return result("compare_and_swap", "conflict", { current: issueCurrent() });
      }
      state.bytes = Uint8Array.from(request.bytes);
      state.generation += 1;
      return result("compare_and_swap", "swapped");
    },
    close(request) {
      state.closeCalls += 1;
      assert.equal(request.abiVersion, ABI_VERSION);
      assert.equal(request.operation, "close");
      if (typeof state.closeOverride === "function") return state.closeOverride(request);
      return result("close", "closed");
    },
  });
  const module = Object.freeze({
    [OPEN_METHOD](request) {
      state.openCalls += 1;
      assert.deepEqual({ ...request }, { abiVersion: ABI_VERSION, operation: "open" });
      return result("open", "opened", { handle });
    },
  });
  return {
    state,
    handle,
    module,
    open() {
      return nativeCell.openRelayV2HostCredentialAtomicFileCellNative({ nativeModule: module });
    },
    externalReplace(bytes) {
      state.bytes = Uint8Array.from(bytes);
      state.generation += 1;
    },
  };
}

function read(cell) {
  return cell.runExclusive((transaction) => transaction.read());
}

function assertRedacted(error, code, forbidden) {
  assert.equal(error?.code, code);
  assert.equal(error?.message.includes(forbidden), false);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

test("injected Host native wrapper owns opaque CAS revisions, terminal fences, and exact close", async () => {
  const hostileObservations = {
    optionGetter: 0,
    moduleGetter: 0,
    handleGetter: 0,
    asyncOpenCalls: 0,
    thenGetter: 0,
  };
  const benign = createHarness();
  const hostileInputs = [
    {
      label: "Proxy options",
      invoke: () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative(new Proxy({}, {})),
      code: "INVALID_ARGUMENT",
    },
    {
      label: "options accessor",
      invoke: () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative(
        Object.defineProperty({}, "nativeModule", {
          get() {
            hostileObservations.optionGetter += 1;
            return benign.module;
          },
        }),
      ),
      code: "INVALID_ARGUMENT",
    },
    {
      label: "module accessor",
      invoke: () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
        nativeModule: Object.defineProperty({}, OPEN_METHOD, {
          get() {
            hostileObservations.moduleGetter += 1;
            return () => undefined;
          },
        }),
      }),
      code: "NATIVE_INTERFACE_INVALID",
    },
    {
      label: "AsyncFunction open",
      invoke: () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
        nativeModule: Object.freeze({
          async [OPEN_METHOD]() {
            hostileObservations.asyncOpenCalls += 1;
          },
        }),
      }),
      code: "NATIVE_INTERFACE_INVALID",
    },
    {
      label: "thenable open result",
      invoke: () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
        nativeModule: Object.freeze({
          [OPEN_METHOD]() {
            return Object.defineProperty(Object.create(null), "then", {
              get() {
                hostileObservations.thenGetter += 1;
                return () => undefined;
              },
            });
          },
        }),
      }),
      code: "NATIVE_INTERFACE_INVALID",
    },
  ];
  for (const entry of hostileInputs) {
    assert.throws(entry.invoke, errorCode(entry.code), entry.label);
  }
  assert.deepEqual(hostileObservations, {
    optionGetter: 0,
    moduleGetter: 0,
    handleGetter: 0,
    asyncOpenCalls: 0,
    thenGetter: 0,
  });

  const capturedFunctionCallCases = [
    {
      label: "captured function own call accessor",
      decorate(method, observation) {
        Object.defineProperty(method, "call", {
          configurable: false,
          get() {
            observation.trapCalls += 1;
            return () => undefined;
          },
        });
      },
    },
    {
      label: "captured function replacement call",
      decorate(method, observation) {
        Object.defineProperty(method, "call", {
          configurable: false,
          value() {
            observation.trapCalls += 1;
            throw new Error("captured call replacement must not run");
          },
        });
      },
    },
  ];
  for (const entry of capturedFunctionCallCases) {
    const observation = { openBodyCalls: 0, readBodyCalls: 0, trapCalls: 0 };
    const rawRevision = Object.freeze(Object.create(null));
    const rawRead = function (request) {
      observation.readBodyCalls += 1;
      assert.equal(request.operation, "read");
      return result("read", "ok", { current: current(rawRevision, null) });
    };
    entry.decorate(rawRead, observation);
    const handle = Object.freeze({
      read: rawRead,
      compareAndSwap() {
        return result("compare_and_swap", "swapped");
      },
      close() {
        return result("close", "closed");
      },
    });
    const open = function (request) {
      observation.openBodyCalls += 1;
      assert.equal(request.operation, "open");
      return result("open", "opened", { handle });
    };
    entry.decorate(open, observation);
    const cell = nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
      nativeModule: Object.freeze({ [OPEN_METHOD]: open }),
    });
    assert.equal(read(cell).bytes, null, entry.label);
    assert.equal(observation.openBodyCalls, 1, entry.label);
    assert.equal(observation.readBodyCalls, 1, entry.label);
    assert.equal(observation.trapCalls, 0, entry.label);
    await cell.closeAndDrain();
  }

  const unpublishedFailures = [
    {
      label: "open result extra field",
      make(handle) {
        return result("open", "opened", { handle, fallback: "forbidden" });
      },
    },
    {
      label: "handle accessor",
      make(_handle, close) {
        const handle = { compareAndSwap() {}, close };
        Object.defineProperty(handle, "read", {
          enumerable: true,
          get() {
            hostileObservations.handleGetter += 1;
            return () => undefined;
          },
        });
        return result("open", "opened", { handle });
      },
    },
    {
      label: "handle AsyncFunction",
      make(_handle, close) {
        return result("open", "opened", {
          handle: Object.freeze({ async read() {}, compareAndSwap() {}, close }),
        });
      },
    },
    {
      label: "handle Proxy",
      make(handle) {
        return result("open", "opened", { handle: new Proxy(handle, {}) });
      },
    },
  ];
  for (const entry of unpublishedFailures) {
    let closeCalls = 0;
    const close = () => {
      closeCalls += 1;
      return result("close", "closed");
    };
    const validHandle = Object.freeze({ read() {}, compareAndSwap() {}, close });
    const module = Object.freeze({
      [OPEN_METHOD]() {
        return entry.make(validHandle, close);
      },
    });
    assert.throws(
      () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({ nativeModule: module }),
      errorCode("NATIVE_INTERFACE_INVALID"),
      entry.label,
    );
    assert.equal(
      closeCalls,
      entry.label === "handle Proxy" ? 0 : 1,
      `${entry.label} closes every safely captured unpublished handle exactly once`,
    );
  }
  assert.equal(hostileObservations.handleGetter, 0);

  const harness = createHarness();
  const cell = harness.open();
  assert.equal(Object.isFrozen(cell), true);
  assert.equal(Object.getPrototypeOf(cell), null);
  assert.deepEqual(Reflect.ownKeys(cell).sort(), ["closeAndDrain", "runExclusive"]);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(cell))) {
    assert.equal(Object.hasOwn(descriptor, "value"), true);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
  }
  assert.equal(harness.state.openCalls, 1);

  let capturedTransaction;
  const empty = cell.runExclusive((transaction) => {
    capturedTransaction = transaction;
    assert.equal(Object.isFrozen(transaction), true);
    assert.equal(Object.getPrototypeOf(transaction), null);
    return transaction.read();
  });
  assert.equal(empty.bytes, null);
  assert.equal(Object.isFrozen(empty), true);
  assert.equal(Object.isFrozen(empty.revision), true);
  assert.equal(Object.getPrototypeOf(empty.revision), null);
  assert.deepEqual(Reflect.ownKeys(empty.revision), []);
  assert.throws(() => capturedTransaction.read(), errorCode("CELL_CLOSED"));

  const newer = read(cell);
  const beforeRejectedMutations = harness.state.compareCalls;
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      empty.revision,
      Uint8Array.of(9),
    )),
    errorCode("INVALID_REVISION"),
  );
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      { ...newer.revision },
      Uint8Array.of(9),
    )),
    errorCode("INVALID_REVISION"),
  );
  const foreignHarness = createHarness();
  const foreignCell = foreignHarness.open();
  const foreignRevision = read(foreignCell).revision;
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      foreignRevision,
      Uint8Array.of(9),
    )),
    errorCode("INVALID_REVISION"),
  );
  assert.equal(harness.state.compareCalls, beforeRejectedMutations);

  const replacement = Uint8Array.of(1, 2, 3);
  let replacementMethodLookups = 0;
  Object.defineProperty(replacement, "set", {
    get() {
      replacementMethodLookups += 1;
      return () => undefined;
    },
  });
  harness.state.onCompare = (request) => {
    replacement.fill(9);
    assert.deepEqual([...request.bytes], [1, 2, 3]);
    assert.notEqual(request.bytes, replacement);
  };
  assert.deepEqual({ ...cell.runExclusive((transaction) => transaction.compareAndSwap(
    newer.revision,
    replacement,
  )) }, { status: "swapped" });
  assert.equal(replacementMethodLookups, 0, "Uint8Array copy uses captured intrinsics");
  harness.state.onCompare = null;
  const afterSwapCalls = harness.state.compareCalls;
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      newer.revision,
      Uint8Array.of(4),
    )),
    errorCode("INVALID_REVISION"),
  );
  assert.equal(harness.state.compareCalls, afterSwapCalls, "replay is rejected before raw mutation");

  const copiedRead = read(cell);
  assert.deepEqual([...copiedRead.bytes], [1, 2, 3]);
  copiedRead.bytes.fill(7);
  assert.deepEqual([...read(cell).bytes], [1, 2, 3], "read bytes never alias raw native state");

  const invalidReplacementRevision = read(cell).revision;
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      invalidReplacementRevision,
      new Uint16Array([1]),
    )),
    errorCode("INVALID_ARGUMENT"),
  );
  assert.throws(
    () => cell.runExclusive((transaction) => transaction.compareAndSwap(
      invalidReplacementRevision,
      new Uint8Array(MAX_BYTES + 1),
    )),
    errorCode("VALUE_TOO_LARGE"),
  );
  assert.equal(cell.runExclusive((transaction) => transaction.compareAndSwap(
    invalidReplacementRevision,
    Uint8Array.of(4),
  )).status, "swapped", "pre-native argument rejection does not consume the revision");

  const beforeConflict = read(cell);
  harness.externalReplace([5, 6]);
  const conflict = cell.runExclusive((transaction) => transaction.compareAndSwap(
    beforeConflict.revision,
    Uint8Array.of(8),
  ));
  assert.equal(conflict.status, "conflict");
  assert.deepEqual([...conflict.current.bytes], [5, 6]);
  assert.equal(cell.runExclusive((transaction) => transaction.compareAndSwap(
    conflict.current.revision,
    Uint8Array.of(8),
  )).status, "swapped");

  const normalClose = cell.closeAndDrain();
  assert.equal(cell.closeAndDrain(), normalClose);
  await normalClose;
  assert.equal(harness.state.closeCalls, 1);
  assert.throws(() => read(cell), errorCode("CELL_CLOSED"));
  await foreignCell.closeAndDrain();

  const fencedCases = [
    {
      label: "uncertain",
      configure(h) {
        h.state.compareOverride = () => result("compare_and_swap", "uncertain");
      },
      exercise(c) {
        const revision = read(c).revision;
        assert.deepEqual({ ...c.runExclusive((transaction) => transaction.compareAndSwap(
          revision,
          Uint8Array.of(1),
        )) }, { status: "uncertain" });
      },
      code: "UNCERTAIN_FENCED",
    },
    {
      label: "extra CAS result",
      configure(h) {
        h.state.compareOverride = () => result("compare_and_swap", "swapped", { detail: null });
      },
      exercise(c) {
        const revision = read(c).revision;
        assert.throws(
          () => c.runExclusive((transaction) => transaction.compareAndSwap(
            revision,
            Uint8Array.of(1),
          )),
          errorCode("NATIVE_INTERFACE_INVALID"),
        );
      },
      code: "UNCERTAIN_FENCED",
    },
    {
      label: "unknown error code",
      configure(h) {
        h.state.readOverride = () => result("read", "error", { error: { code: "UNKNOWN" } });
      },
      exercise(c) {
        assert.throws(() => read(c), errorCode("NATIVE_INTERFACE_INVALID"));
      },
      code: "UNCERTAIN_FENCED",
    },
    {
      label: "thenable raw read",
      configure(h, observation) {
        h.state.readOverride = () => Object.defineProperty(Object.create(null), "then", {
          get() {
            observation.thenRead += 1;
            return () => undefined;
          },
        });
      },
      exercise(c) {
        assert.throws(() => read(c), errorCode("NATIVE_INTERFACE_INVALID"));
      },
      code: "UNCERTAIN_FENCED",
    },
    {
      label: "Promise raw read with own then trap",
      configure(h, observation) {
        const promise = Promise.resolve(result("read", "ok", { current: null }));
        Object.defineProperty(promise, "then", {
          get() {
            observation.promiseThen += 1;
            return () => undefined;
          },
        });
        h.state.readOverride = () => promise;
      },
      exercise(c) {
        assert.throws(() => read(c), errorCode("NATIVE_INTERFACE_INVALID"));
      },
      code: "UNCERTAIN_FENCED",
    },
  ];
  const fenceObservation = { thenRead: 0, promiseThen: 0 };
  for (const entry of fencedCases) {
    const fenced = createHarness();
    entry.configure(fenced, fenceObservation);
    const fencedCell = fenced.open();
    entry.exercise(fencedCell);
    assert.throws(() => read(fencedCell), errorCode(entry.code), entry.label);
    const close = fencedCell.closeAndDrain();
    assert.equal(fencedCell.closeAndDrain(), close, entry.label);
    await close;
    assert.equal(fenced.state.closeCalls, 1, entry.label);
  }
  assert.equal(fenceObservation.thenRead, 0);
  assert.equal(fenceObservation.promiseThen, 0);

  const sensitiveDetail = "sensitive-native-detail-must-not-escape";
  const redactionCases = [
    {
      label: "raw error detail",
      configure(h) {
        h.state.readOverride = () => result("read", "error", {
          error: { code: "CELL_IO", message: sensitiveDetail },
        });
      },
    },
    {
      label: "raw throw",
      configure(h) {
        h.state.readOverride = () => { throw new Error(sensitiveDetail); };
      },
    },
    {
      label: "raw throw public wrapper error",
      configure(h) {
        h.state.readOverride = () => {
          throw new nativeCell.RelayV2HostCredentialAtomicFileCellNativeError("CELL_IO");
        };
      },
    },
    {
      label: "raw throw public wrapper error with mutated code",
      configure(h) {
        const rawError = new nativeCell.RelayV2HostCredentialAtomicFileCellNativeError("CELL_IO");
        rawError.code = "CELL_BUSY";
        rawError.message = sensitiveDetail;
        h.state.readOverride = () => { throw rawError; };
      },
    },
  ];
  for (const entry of redactionCases) {
    const redacted = createHarness();
    entry.configure(redacted);
    const redactedCell = redacted.open();
    assert.throws(
      () => read(redactedCell),
      (error) => assertRedacted(error, "NATIVE_INTERFACE_INVALID", sensitiveDetail),
      entry.label,
    );
    assert.throws(() => read(redactedCell), errorCode("UNCERTAIN_FENCED"));
    await redactedCell.closeAndDrain();
  }

  const closeFailure = createHarness();
  closeFailure.state.closeOverride = () => { throw new Error(sensitiveDetail); };
  const closeFailureCell = closeFailure.open();
  const failedClose = closeFailureCell.closeAndDrain();
  assert.equal(closeFailureCell.closeAndDrain(), failedClose);
  await assert.rejects(
    failedClose,
    (error) => assertRedacted(error, "NATIVE_INTERFACE_INVALID", sensitiveDetail),
  );
  assert.equal(closeFailure.state.closeCalls, 1);

  const callbackFence = createHarness();
  const callbackFenceCell = callbackFence.open();
  let thenGetterCalls = 0;
  assert.throws(
    () => callbackFenceCell.runExclusive(() => Object.defineProperty(
      Object.create(null),
      "then",
      {
        get() {
          thenGetterCalls += 1;
          return () => undefined;
        },
      },
    )),
    errorCode("ASYNC_OPERATION_UNSUPPORTED"),
  );
  assert.equal(thenGetterCalls, 0);
  assert.throws(() => read(callbackFenceCell), errorCode("UNCERTAIN_FENCED"));
  await callbackFenceCell.closeAndDrain();
});
