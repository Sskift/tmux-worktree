import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";

const nativeArtifact = process.env.RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT;
const explicitExpectedPlatform =
  process.env.RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_EXPECTED_PLATFORM;
const explicitExpectedArchitecture =
  process.env.RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_EXPECTED_ARCHITECTURE;
assert.equal(
  explicitExpectedPlatform === undefined,
  explicitExpectedArchitecture === undefined,
  "expected platform and architecture must be supplied together",
);
const expectedPlatform = explicitExpectedPlatform ?? "darwin";
const expectedArchitecture = explicitExpectedArchitecture ?? process.arch;
assert.match(expectedPlatform, /^(darwin|linux)$/);
assert.match(expectedArchitecture, /^(arm64|x64)$/);

const nativeCell = await import("../dist/relay/v2/hostCredentialAtomicFileCellNative.js");

const OPEN_METHOD = "openRelayV2HostCredentialAtomicFileCellV1";
const POISONED_NAMES = [
  OPEN_METHOD,
  "abiVersion",
  "operation",
  "outcome",
  "handle",
  "error",
  "code",
  "current",
  "state",
  "revision",
  "bytes",
];

function exactOwnDataKeys(value) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    assert.equal(Object.hasOwn(descriptor, "value"), true);
    assert.equal(Object.hasOwn(descriptor, "get"), false);
    assert.equal(Object.hasOwn(descriptor, "set"), false);
  }
  return Reflect.ownKeys(descriptors).sort();
}

function assertExactErrorResult(result, code, setterCalls, beforeCalls, label) {
  assert.equal(setterCalls, beforeCalls, `${label} result bypasses prototype setters`);
  assert.deepEqual(exactOwnDataKeys(result), ["abiVersion", "error", "operation", "outcome"], label);
  assert.deepEqual(exactOwnDataKeys(result.error), ["code"], label);
  assert.equal(Object.getPrototypeOf(result), Object.prototype, label);
  assert.equal(Object.getPrototypeOf(result.error), Object.prototype, label);
  assert.deepEqual(result, {
    abiVersion: 1,
    operation: "open",
    outcome: "error",
    error: { code },
  }, label);
}

test("actual selected-target binding is exact, prototype-safe, and closed before registry or mutation", {
  skip: nativeArtifact === undefined
    ? "RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT is required for the focused native run"
    : false,
}, () => {
  assert.equal(process.platform, expectedPlatform);
  assert.equal(process.arch, expectedArchitecture);
  const artifact = nativeArtifact;
  assert.equal(typeof artifact, "string");
  assert.equal(isAbsolute(artifact), true);
  assert.equal(resolve(artifact), artifact);
  assert.equal(existsSync(artifact), true);

  let setterCalls = 0;
  const previous = new Map();
  for (const name of new Set(POISONED_NAMES)) {
    previous.set(name, Object.getOwnPropertyDescriptor(Object.prototype, name));
    Object.defineProperty(Object.prototype, name, {
      configurable: true,
      set() { setterCalls += 1; },
    });
  }

  const originalHome = process.env.HOME;
  const ignoredEnvironmentHome = join(
    tmpdir(),
    `tw-relay-v2-host-cell-env-home-${process.pid}-${Date.now()}`,
  );
  assert.equal(existsSync(ignoredEnvironmentHome), false);
  process.env.HOME = ignoredEnvironmentHome;

  try {
    const beforeRequire = setterCalls;
    const binding = createRequire(import.meta.url)(artifact);
    assert.equal(setterCalls, beforeRequire, "module exports bypass prototype setters");
    assert.deepEqual(exactOwnDataKeys(binding), [OPEN_METHOD]);
    assert.equal(typeof binding[OPEN_METHOD], "function");

    const beforeOpen = setterCalls;
    const openResult = binding[OPEN_METHOD](Object.freeze({
      abiVersion: 1,
      operation: "open",
    }));
    assertExactErrorResult(
      openResult,
      "CELL_DURABILITY_UNSUPPORTED",
      setterCalls,
      beforeOpen,
      "frozen open",
    );

    const malformed = [
      ["non-object", 7, "INVALID_ARGUMENT"],
      ["null", null, "INVALID_ARGUMENT"],
      ["array", [], "INVALID_ARGUMENT"],
      ["extra key", { abiVersion: 1, operation: "open", fallback: "v1" }, "INVALID_ARGUMENT"],
      ["missing operation", { abiVersion: 1 }, "INVALID_ARGUMENT"],
      ["wrong abiVersion", { abiVersion: 2, operation: "open" }, "INVALID_ARGUMENT"],
      ["non-number abiVersion", { abiVersion: "1", operation: "open" }, "INVALID_ARGUMENT"],
      ["wrong operation", { abiVersion: 1, operation: "read" }, "INVALID_ARGUMENT"],
      ["non-string operation", { abiVersion: 1, operation: 1 }, "INVALID_ARGUMENT"],
      ["accessor field", Object.defineProperty({ operation: "open" }, "abiVersion", {
        enumerable: true,
        get() { return 1; },
      }), "INVALID_ARGUMENT"],
      ["ownKeys trap", new Proxy({}, {
        ownKeys() { throw new Error("must not escape"); },
      }), "NATIVE_INTERFACE_INVALID"],
      ["descriptor trap", new Proxy({}, {
        ownKeys() { return ["abiVersion", "operation"]; },
        getOwnPropertyDescriptor() { throw new Error("must not escape"); },
      }), "NATIVE_INTERFACE_INVALID"],
    ];
    for (const [label, request, expectedCode] of malformed) {
      const beforeMalformed = setterCalls;
      let result;
      assert.doesNotThrow(() => {
        result = binding[OPEN_METHOD](request);
      }, label);
      assertExactErrorResult(result, expectedCode, setterCalls, beforeMalformed, label);
    }

    // The closed open never touches HOME, path, environment, or filesystem:
    // a redirected missing HOME changes nothing and is never created.
    const beforeHomeOpen = setterCalls;
    const homeOpenResult = binding[OPEN_METHOD](Object.freeze({
      abiVersion: 1,
      operation: "open",
    }));
    assertExactErrorResult(
      homeOpenResult,
      "CELL_DURABILITY_UNSUPPORTED",
      setterCalls,
      beforeHomeOpen,
      "redirected-HOME open",
    );
    assert.equal(existsSync(ignoredEnvironmentHome), false);

    // The canonical wrapper decodes the same closed error and throws its
    // own stable code without opening a cell.
    assert.throws(
      () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({ nativeModule: binding }),
      (error) => {
        assert.equal(error?.name, "RelayV2HostCredentialAtomicFileCellNativeError");
        assert.equal(error?.code, "CELL_DURABILITY_UNSUPPORTED");
        return true;
      },
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete Object.prototype[name];
      else Object.defineProperty(Object.prototype, name, descriptor);
    }
  }
});
