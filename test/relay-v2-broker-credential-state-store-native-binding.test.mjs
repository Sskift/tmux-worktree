import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const stateStore = await import("../dist/relay/v2/brokerCredentialStateStore.js");
const nativeArtifact = process.env.RELAY_V2_BROKER_CREDENTIAL_NATIVE_TEST_ARTIFACT;

const EXPORT_KEYS = [
  "openRelayV2BrokerCredentialStateStore",
  "relayV2BrokerCredentialStateCapability",
];
const CAPABILITY_KEYS = [
  "durability",
  "features",
  "interfaceVersion",
  "maxStateBytes",
  "nativeAbi",
  "status",
  "storageFormatVersion",
];
const POISONED_NAMES = [
  ...EXPORT_KEYS,
  ...CAPABILITY_KEYS,
  "error",
  "code",
  "reason",
  "selfCheck",
  "store",
  "runExclusive",
  "close",
  "read",
  "compareAndPublish",
  "outcome",
  "revision",
  "bytes",
  "current",
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

test("actual Darwin binding is exact, prototype-safe, wrapper-decodable, and closed before store observation", {
  skip: nativeArtifact === undefined
    ? "RELAY_V2_BROKER_CREDENTIAL_NATIVE_TEST_ARTIFACT is required for the focused native run"
    : false,
}, async () => {
  assert.equal(process.platform, "darwin");
  assert.match(process.arch, /^(arm64|x64)$/);
  const artifact = nativeArtifact;
  assert.equal(typeof artifact, "string");
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
  const nonce = `${process.pid}-${Date.now()}`;
  const nonAccountHome = join(tmpdir(), `tw-relay-v2-native-non-account-${nonce}`);
  const ignoredEnvironmentHome = join(tmpdir(), `tw-relay-v2-native-env-home-${nonce}`);
  assert.equal(existsSync(nonAccountHome), false);
  assert.equal(existsSync(ignoredEnvironmentHome), false);
  process.env.HOME = ignoredEnvironmentHome;

  try {
    const beforeRequire = setterCalls;
    const binding = createRequire(import.meta.url)(artifact);
    assert.equal(setterCalls, beforeRequire, "module exports bypass prototype setters");
    assert.deepEqual(exactOwnDataKeys(binding), EXPORT_KEYS);
    assert.equal(typeof binding.relayV2BrokerCredentialStateCapability, "function");
    assert.equal(typeof binding.openRelayV2BrokerCredentialStateStore, "function");

    const beforeCapability = setterCalls;
    const rawCapability = binding.relayV2BrokerCredentialStateCapability();
    assert.equal(setterCalls, beforeCapability, "capability fields bypass prototype setters");
    assert.deepEqual(exactOwnDataKeys(rawCapability), CAPABILITY_KEYS);
    const capability = stateStore.readRelayV2BrokerCredentialStateStoreNativeCapability(binding);
    assert.equal(capability.status, "supported");
    assert.equal(capability.nativeAbi, "napi");
    assert.equal(capability.interfaceVersion, 1);

    const wrongTypeOpen = binding.openRelayV2BrokerCredentialStateStore(Object.freeze({
      trustedHome: 7,
      maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
    }));
    assert.deepEqual(exactOwnDataKeys(wrongTypeOpen), ["error", "status"]);
    assert.deepEqual(exactOwnDataKeys(wrongTypeOpen.error), ["code"]);
    assert.deepEqual(wrongTypeOpen, {
      status: "invalid",
      error: { code: "INVALID_ARGUMENT" },
    });

    const hostileOptions = [
      ["ownKeys trap", new Proxy({}, {
        ownKeys() { throw new Error("must not escape"); },
      })],
      ["getOwnPropertyDescriptor trap", new Proxy({}, {
        ownKeys() { return ["trustedHome", "maxStateBytes"]; },
        getOwnPropertyDescriptor() { throw new Error("must not escape"); },
      })],
      ["invalid descriptor conversion", new Proxy({}, {
        ownKeys() { return ["trustedHome", "maxStateBytes"]; },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true, get: 1 };
        },
      })],
    ];
    for (const [label, hostile] of hostileOptions) {
      const beforeHostileOpen = setterCalls;
      let hostileResult;
      assert.doesNotThrow(() => {
        hostileResult = binding.openRelayV2BrokerCredentialStateStore(hostile);
      }, label);
      assert.equal(setterCalls, beforeHostileOpen, `${label} result bypasses prototype setters`);
      assert.deepEqual(exactOwnDataKeys(hostileResult), ["error", "status"]);
      assert.deepEqual(exactOwnDataKeys(hostileResult.error), ["code"]);
      assert.deepEqual(hostileResult, {
        status: "invalid",
        error: { code: "NATIVE_INTERFACE_INVALID" },
      });
    }

    const options = Object.freeze({
      trustedHome: nonAccountHome,
      maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
    });
    const beforeOpen = setterCalls;
    const rawOpen = binding.openRelayV2BrokerCredentialStateStore(options);
    assert.equal(setterCalls, beforeOpen, "open/error fields bypass prototype setters");
    assert.deepEqual(exactOwnDataKeys(rawOpen), ["error", "status"]);
    assert.deepEqual(exactOwnDataKeys(rawOpen.error), ["code"]);
    assert.equal(Object.getPrototypeOf(rawOpen.error), Object.prototype);
    assert.deepEqual(rawOpen, {
      status: "invalid",
      error: { code: "STORE_PERMISSION_INVALID" },
    });

    const decoded = await stateStore.openRelayV2BrokerCredentialStateStoreNativeBinding(
      binding,
      options,
    );
    assert.deepEqual(decoded, {
      status: "invalid",
      error: { code: "STORE_PERMISSION_INVALID" },
    });
    assert.equal(existsSync(nonAccountHome), false);
    assert.equal(existsSync(ignoredEnvironmentHome), false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete Object.prototype[name];
      else Object.defineProperty(Object.prototype, name, descriptor);
    }
  }
});
