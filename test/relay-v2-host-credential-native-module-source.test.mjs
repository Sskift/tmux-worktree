import assert from "node:assert/strict";
import test from "node:test";

const sourceModule = await import(
  "../dist/relay/v2/hostCredentialNativeModuleSource.js"
);
const nativeCellModule = await import(
  "../dist/relay/v2/hostCredentialAtomicFileCellNative.js"
);

const {
  createRelayV2HostCredentialNativeModuleSource: createSource,
} = sourceModule;
const {
  openRelayV2HostCredentialAtomicFileCellNative: openNativeCell,
} = nativeCellModule;

const OPEN_METHOD = "openRelayV2HostCredentialAtomicFileCellV1";

function target(platform = "darwin", architecture = "arm64", napiVersion = 9) {
  return { platform, architecture, napiVersion };
}

function fakeNativeModule() {
  const stats = { opens: 0, closes: 0 };
  let bytes = null;
  const handle = {
    read(request) {
      return {
        abiVersion: 1,
        operation: "read",
        outcome: "ok",
        current: bytes === null
          ? { state: "empty", revision: Object.freeze({}) }
          : { state: "present", revision: Object.freeze({}), bytes: Uint8Array.from(bytes) },
      };
    },
    compareAndSwap(request) {
      bytes = Uint8Array.from(request.bytes);
      return { abiVersion: 1, operation: "compare_and_swap", outcome: "swapped" };
    },
    close(request) {
      stats.closes += 1;
      return { abiVersion: 1, operation: "close", outcome: "closed" };
    },
  };
  const nativeModule = {
    [OPEN_METHOD](request) {
      stats.opens += 1;
      return { abiVersion: 1, operation: "open", outcome: "opened", handle };
    },
  };
  return { nativeModule, stats };
}

function assertSourceError(error, code) {
  assert.equal(error?.name, "RelayV2HostCredentialNativeModuleSourceError");
  assert.equal(error?.code, code);
  assert.equal(Object.hasOwn(error, "cause"), false);
  return true;
}

test("injected descriptor, supported/unsupported capability, and memoization", () => {
  // The injected loader receives the frozen exact target descriptor; no
  // artifact specifier or path exists anywhere on it.
  const cases = [
    ["darwin", "arm64", "darwin-arm64", "aarch64-apple-darwin"],
    ["darwin", "x64", "darwin-x64", "x86_64-apple-darwin"],
    ["linux", "arm64", "linux-arm64", "aarch64-unknown-linux-gnu"],
    ["linux", "x64", "linux-x64", "x86_64-unknown-linux-gnu"],
  ];
  for (const [platform, architecture, expectedTarget, cargoTargetTriple] of cases) {
    let loads = 0;
    const fake = fakeNativeModule();
    const source = createSource(target(platform, architecture), (descriptor) => {
      loads += 1;
      assert.deepEqual(descriptor, {
        target: expectedTarget,
        platform,
        architecture,
        cargoTargetTriple,
      });
      assert.equal(Object.isFrozen(descriptor), true);
      assert.equal("moduleSpecifier" in descriptor, false);
      assert.equal("path" in descriptor, false);
      return { status: "loaded", binding: fake.nativeModule };
    });
    const capability = source.capability();
    assert.deepEqual(capability, {
      status: "supported",
      target: expectedTarget,
      platform,
      architecture,
      contractRevision: 6,
      abi: "napi",
      abiVersion: 1,
    });
    assert.equal("ready" in capability, false, "capability is never a readiness result");
    assert.strictEqual(source.capability(), capability, "capability is memoized");
    assert.equal(loads, 1, `${expectedTarget} loads exactly once`);
    assert.equal(fake.stats.opens, 0, "the source never calls the module open method");
  }

  // Unsupported targets fail closed before any load.
  for (const napiVersion of [9, 8]) {
    let loads = 0;
    const source = createSource(target("win32", "x64", napiVersion), () => {
      loads += 1;
      throw new Error("must not load an unsupported target");
    });
    assert.deepEqual(source.capability(), {
      status: "unsupported",
      reason: "target_unsupported",
    });
    assert.throws(
      () => source.takeNativeModule(),
      (error) => assertSourceError(error, "TARGET_UNSUPPORTED"),
    );
    assert.equal(loads, 0);
  }

  // Low, non-integer, or non-numeric interface versions fail closed too.
  for (const napiVersion of [8, 9.5, Number.NaN]) {
    let loads = 0;
    const source = createSource(target("darwin", "arm64", napiVersion), () => {
      loads += 1;
      return { status: "missing" };
    });
    assert.deepEqual(source.capability(), {
      status: "unsupported",
      reason: "interface_version_unsupported",
    });
    assert.throws(
      () => source.takeNativeModule(),
      (error) => assertSourceError(error, "INTERFACE_VERSION_UNSUPPORTED"),
    );
    assert.equal(loads, 0);
  }
});

test("one-shot take and close ownership semantics", () => {
  // The first take delivers the exact original identity; the second fails.
  const fake = fakeNativeModule();
  let loads = 0;
  const source = createSource(target(), () => {
    loads += 1;
    return { status: "loaded", binding: fake.nativeModule };
  });
  assert.strictEqual(
    source.takeNativeModule,
    source.takeNativeModule,
    "the exposed take callable keeps one stable identity",
  );
  const delivered = source.takeNativeModule();
  assert.strictEqual(delivered, fake.nativeModule, "the exact identity is delivered");
  assert.equal(fake.stats.opens, 0, "take never opens the cell");
  assert.throws(
    () => source.takeNativeModule(),
    (error) => assertSourceError(error, "SOURCE_CONSUMED"),
  );
  assert.equal(loads, 1, "delivery never reloads");
  // Close after delivery is a no-op that never touches the delivered module.
  source.close();
  assert.equal(fake.stats.closes, 0);

  // Close before any probe fences take and reports invalid without loading.
  let unprobedLoads = 0;
  const unprobed = createSource(target(), () => {
    unprobedLoads += 1;
    return { status: "missing" };
  });
  unprobed.close();
  assert.throws(
    () => unprobed.takeNativeModule(),
    (error) => assertSourceError(error, "SOURCE_CLOSED"),
  );
  assert.deepEqual(unprobed.capability(), {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  }, "a closed-before-probe source reports invalid instead of loading");
  assert.equal(unprobedLoads, 0);

  // A failed take is memoized: same error, loader still exactly one call.
  let failedLoads = 0;
  const failed = createSource(target(), () => {
    failedLoads += 1;
    return { status: "loaded", binding: {} };
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => failed.takeNativeModule(),
      (error) => assertSourceError(error, "SOURCE_INVALID"),
    );
  }
  assert.equal(failedLoads, 1);
});

test("selection-in-progress fence against re-entrant close and take", () => {
  // (a) A loader that synchronously closes the source mid-callback: nothing
  // is stored, the binding is dropped, and the outer take fails closed.
  const closingFake = fakeNativeModule();
  let closingLoads = 0;
  let closingSource;
  closingSource = createSource(target(), () => {
    closingLoads += 1;
    closingSource.close();
    return { status: "loaded", binding: closingFake.nativeModule };
  });
  assert.throws(
    () => closingSource.takeNativeModule(),
    (error) => assertSourceError(error, "SOURCE_CLOSED"),
  );
  assert.equal(closingLoads, 1, "the loader still ran exactly once");
  assert.deepEqual(closingSource.capability(), {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  }, "a mid-selection close never stores the binding or reports supported");
  assert.equal(closingFake.stats.opens, 0);

  // (b) A loader that synchronously probes/takes mid-callback: the re-entrant
  // selection fails closed without being memoized, the loader ran once, and
  // the outer take still delivers exactly once.
  const reentryFake = fakeNativeModule();
  let reentryLoads = 0;
  let reentrySource;
  let reentrantCapability = null;
  let reentrantTakeError = null;
  reentrySource = createSource(target(), () => {
    reentryLoads += 1;
    reentrantCapability = reentrySource.capability();
    try {
      reentrySource.takeNativeModule();
    } catch (error) {
      reentrantTakeError = error;
    }
    return { status: "loaded", binding: reentryFake.nativeModule };
  });
  const delivered = reentrySource.takeNativeModule();
  assert.strictEqual(delivered, reentryFake.nativeModule, "the outer take delivers exactly once");
  assert.deepEqual(reentrantCapability, {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  }, "a re-entrant probe fails closed without being memoized");
  assertSourceError(reentrantTakeError, "SOURCE_INVALID");
  assert.equal(reentryLoads, 1, "the loader never runs twice");
  assert.throws(
    () => reentrySource.takeNativeModule(),
    (error) => assertSourceError(error, "SOURCE_CONSUMED"),
  );
});

test("ABI admission rejects foreign shapes and preserves the receiver", () => {
  let hostileOpens = 0;
  const countingOpen = () => {
    hostileOpens += 1;
    return { abiVersion: 1, operation: "open", outcome: "error", error: { code: "CELL_IO" } };
  };
  const hostileBindings = [
    ["proxy module", new Proxy({ [OPEN_METHOD]: countingOpen }, {})],
    ["accessor open method", Object.defineProperty({}, OPEN_METHOD, {
      enumerable: true,
      get() { return countingOpen; },
    })],
    ["extra method", { [OPEN_METHOD]: countingOpen, fallback() {} }],
    ["missing method", {}],
    ["async method", { async [OPEN_METHOD]() {} }],
    ["non-function open method", { [OPEN_METHOD]: 1 }],
    ["array", [{ [OPEN_METHOD]: countingOpen }]],
    ["own-then thenable", { [OPEN_METHOD]: countingOpen, then() {} }],
    ["inherited thenable", Object.assign(
      Object.create({ then() { hostileOpens += 1; } }),
      { [OPEN_METHOD]: countingOpen },
    )],
    ["class instance", new (class {
      [OPEN_METHOD]() { hostileOpens += 1; }
    })()],
  ];
  for (const [label, binding] of hostileBindings) {
    let loads = 0;
    const source = createSource(target(), () => {
      loads += 1;
      return { status: "loaded", binding };
    });
    assert.deepEqual(source.capability(), {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    }, label);
    assert.throws(
      () => source.takeNativeModule(),
      (error) => assertSourceError(error, "SOURCE_INVALID"),
      label,
    );
    assert.equal(loads, 1, `${label}: load happens once, ABI rejects before any open`);
  }
  assert.equal(hostileOpens, 0, "the source never calls a rejected module open method");

  // A valid module is delivered with the exact original identity preserved.
  const fake = fakeNativeModule();
  const valid = createSource(target(), () => ({ status: "loaded", binding: fake.nativeModule }));
  assert.strictEqual(valid.takeNativeModule(), fake.nativeModule);
});

test("missing stays unsupported while failures stay redacted invalid", () => {
  // A missing artifact is unsupported, memoized, and never retried.
  let missingLoads = 0;
  const missing = createSource(target(), () => {
    missingLoads += 1;
    return { status: "missing" };
  });
  assert.deepEqual(missing.capability(), {
    status: "unsupported",
    reason: "native_artifact_missing",
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => missing.takeNativeModule(),
      (error) => assertSourceError(error, "NATIVE_ARTIFACT_MISSING"),
    );
  }
  assert.equal(missingLoads, 1);

  // A loader that throws sensitive detail is mapped to a redacted invalid
  // without reflection, and the failure is memoized.
  let throwingLoads = 0;
  const throwing = createSource(target(), () => {
    throwingLoads += 1;
    throw new Error("dlopen failed at /sensitive/path with token twhostboot2.secret");
  });
  const capability = throwing.capability();
  assert.deepEqual(capability, {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  });
  assert.doesNotMatch(JSON.stringify(capability), /sensitive|dlopen|twhostboot2/i);
  assert.throws(
    () => throwing.takeNativeModule(),
    (error) => {
      assertSourceError(error, "SOURCE_INVALID");
      assert.doesNotMatch(String(error), /sensitive|dlopen|twhostboot2/i);
      return true;
    },
  );
  assert.equal(throwingLoads, 1);

  // Malformed load results are invalid, never partially trusted.
  const fake = fakeNativeModule();
  let statusGetterReads = 0;
  const accessorResult = {};
  Object.defineProperty(accessorResult, "status", {
    enumerable: true,
    get() {
      statusGetterReads += 1;
      return "missing";
    },
  });
  const malformedResults = [
    ["extra field", { status: "missing", fallback: "v1" }],
    ["accessor status", accessorResult],
    ["proxy result", new Proxy({ status: "missing" }, {})],
    ["unknown status", { status: "future" }],
    ["missing with binding", { status: "missing", binding: fake.nativeModule }],
    ["loaded without binding", { status: "loaded" }],
  ];
  for (const [label, result] of malformedResults) {
    const source = createSource(target(), () => result);
    assert.deepEqual(source.capability(), {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    }, label);
    assert.throws(
      () => source.takeNativeModule(),
      (error) => assertSourceError(error, "SOURCE_INVALID"),
      label,
    );
  }
  assert.equal(statusGetterReads, 0);
});

test("taken module opens through the real wrapper and closes once", async () => {
  const fake = fakeNativeModule();
  const source = createSource(target(), () => ({ status: "loaded", binding: fake.nativeModule }));
  const taken = source.takeNativeModule();
  const cell = openNativeCell({ nativeModule: taken });
  assert.equal(fake.stats.opens, 1, "only the wrapper opens the cell");
  const empty = cell.runExclusive((transaction) => transaction.read());
  assert.equal(empty.bytes, null);
  await cell.closeAndDrain();
  assert.equal(fake.stats.opens, 1);
  assert.equal(fake.stats.closes, 1, "the cell closes exactly once through the wrapper");
  source.close();
  assert.equal(fake.stats.closes, 1, "source close after delivery never touches the module");
});
