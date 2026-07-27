import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const FACTORY_METHOD = "createRelayV2HostCredentialAtomicFileCellTrustedFactoryV1";
const CLOSED_CODES = new Set([
  "NATIVE_INTERFACE_INVALID",
  "CELL_BUSY",
  "CELL_CLOSED",
  "CELL_CORRUPT",
  "CELL_IDENTITY_UNCERTAIN",
  "CELL_IO",
  "CELL_PERMISSION_INVALID",
  "CELL_DURABILITY_UNSUPPORTED",
  "CELL_RECOVERY_REQUIRED",
  "INVALID_ARGUMENT",
  "INVALID_REVISION",
  "VALUE_TOO_LARGE",
]);
const POISONED_NAMES = [
  OPEN_METHOD,
  FACTORY_METHOD,
  "abiVersion",
  "operation",
  "outcome",
  "bind",
  "module",
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

test("actual selected-target factory invalid-first call consumes the process claim", {
  skip: nativeArtifact === undefined
    ? "RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT is required for the focused native run"
    : false,
}, () => {
  const probe = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const binding = require(process.env.RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT);
    const open = binding.openRelayV2HostCredentialAtomicFileCellV1;
    const factory = Object.getOwnPropertyDescriptor(
      open,
      "createRelayV2HostCredentialAtomicFileCellTrustedFactoryV1",
    ).value;
    assert.deepStrictEqual(factory({ path: "/tmp" }), {
      outcome: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    assert.deepStrictEqual(factory(), {
      outcome: "error",
      error: { code: "CELL_CLOSED" },
    });
    assert.deepStrictEqual(factory({ malformed: true }), {
      outcome: "error",
      error: { code: "CELL_CLOSED" },
    });
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELAY_V2_HOST_CREDENTIAL_NATIVE_TEST_ARTIFACT: nativeArtifact,
    },
  });
  assert.equal(probe.signal, null);
  assert.equal(probe.status, 0, probe.stderr);
});

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
    // The frozen v1 module surface stays exactly `{ open }`: contract
    // revision 7 carries the trusted factory only as an additive own-data
    // entry on the raw open function. Its only production driver is the
    // fixed trusted loader; nothing here depends on entry visibility.
    assert.deepEqual(exactOwnDataKeys(binding), [OPEN_METHOD]);
    assert.equal(typeof binding[OPEN_METHOD], "function");
    const factoryDescriptor =
      Object.getOwnPropertyDescriptor(binding[OPEN_METHOD], FACTORY_METHOD);
    assert.notEqual(factoryDescriptor, undefined, "factory entry on the raw open function");
    assert.equal(Object.hasOwn(factoryDescriptor, "value"), true);
    assert.equal(Object.hasOwn(factoryDescriptor, "get"), false);
    assert.equal(Object.hasOwn(factoryDescriptor, "set"), false);
    assert.equal(typeof factoryDescriptor.value, "function");
    const factory = factoryDescriptor.value;

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

    // Exactly-once factory drive. On a machine without the deployed private
    // cell directory the producer fails closed with one closed code; on a
    // machine that has it, the one-shot binder returns the final module whose
    // open still fails at the durability gate. Either way the factory never
    // reads the redirected HOME and the replayed second call is CELL_CLOSED.
    const beforeFactory = setterCalls;
    const factoryResult = factory();
    assert.equal(setterCalls, beforeFactory, "factory result bypasses prototype setters");
    const factoryKeys = exactOwnDataKeys(factoryResult);
    if (factoryResult.outcome === "error") {
      assert.deepEqual(factoryKeys, ["error", "outcome"]);
      assert.deepEqual(exactOwnDataKeys(factoryResult.error), ["code"]);
      assert.equal(CLOSED_CODES.has(factoryResult.error.code), true);
    } else {
      assert.deepEqual(factoryKeys, ["bind", "outcome"]);
      assert.equal(factoryResult.outcome, "ready");
      assert.equal(typeof factoryResult.bind, "function");
      const beforeBind = setterCalls;
      const bindResult = factoryResult.bind();
      assert.equal(setterCalls, beforeBind, "bind result bypasses prototype setters");
      assert.deepEqual(exactOwnDataKeys(bindResult), ["module", "outcome"]);
      assert.equal(bindResult.outcome, "bound");
      assert.deepEqual(exactOwnDataKeys(bindResult.module), [OPEN_METHOD]);
      assert.equal(
        Object.getOwnPropertyDescriptor(bindResult.module[OPEN_METHOD], FACTORY_METHOD),
        undefined,
        "final module open never carries the trusted factory entry",
      );
      const beforeBoundOpen = setterCalls;
      const boundOpenResult = bindResult.module[OPEN_METHOD](Object.freeze({
        abiVersion: 1,
        operation: "open",
      }));
      assertExactErrorResult(
        boundOpenResult,
        "CELL_DURABILITY_UNSUPPORTED",
        setterCalls,
        beforeBoundOpen,
        "bound module open",
      );
      // The canonical wrapper admits the final module and decodes the same
      // closed gate error without opening a cell.
      assert.throws(
        () => nativeCell.openRelayV2HostCredentialAtomicFileCellNative({
          nativeModule: bindResult.module,
        }),
        (error) => {
          assert.equal(error?.name, "RelayV2HostCredentialAtomicFileCellNativeError");
          assert.equal(error?.code, "CELL_DURABILITY_UNSUPPORTED");
          return true;
        },
      );
      const replayBindResult = factoryResult.bind();
      assert.deepEqual(exactOwnDataKeys(replayBindResult), ["error", "outcome"]);
      assert.deepEqual(replayBindResult, {
        outcome: "error",
        error: { code: "CELL_CLOSED" },
      });
    }
    const replayFactoryResult = factory(Object.freeze({ path: "/tmp" }));
    assert.deepEqual(exactOwnDataKeys(replayFactoryResult), ["error", "outcome"]);
    assert.deepEqual(replayFactoryResult, {
      outcome: "error",
      error: { code: "CELL_CLOSED" },
    });
    assert.deepEqual(factory(), {
      outcome: "error",
      error: { code: "CELL_CLOSED" },
    });
    assert.equal(existsSync(ignoredEnvironmentHome), false);

    // The frozen v1 observable behavior is unchanged: the canonical wrapper
    // admits the raw artifact and decodes the same closed gate error without
    // opening a cell.
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
