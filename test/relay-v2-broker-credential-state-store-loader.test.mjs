import assert from "node:assert/strict";
import test from "node:test";
import { loadRelayV2BrokerCredentialStateStoreCorpus } from "./support/relayV2BrokerCredentialStateStoreFixtures.mjs";

const loaderModule = await import("../dist/relay/v2/brokerCredentialStateStoreLoader.js");
const stateStore = await import("../dist/relay/v2/brokerCredentialStateStore.js");
const corpus = loadRelayV2BrokerCredentialStateStoreCorpus();

const SUPPORTED_CAPABILITY = corpus.manifest.capability.supported;

function target(platform = "darwin", architecture = "arm64", napiVersion = 9) {
  return { platform, architecture, napiVersion };
}

function rawStore() {
  return Object.freeze({
    runExclusive: async (callback) => callback(Object.freeze({
      read: async () => ({ outcome: "missing", revision: Object.freeze({}) }),
      compareAndPublish: async () => ({ outcome: "uncertain" }),
    })),
    close: async () => undefined,
  });
}

function binding(capabilityResult, openImplementation = () => ({
  status: "opened",
  selfCheck: "passed",
  store: rawStore(),
})) {
  return {
    relayV2BrokerCredentialStateCapability: () => capabilityResult,
    openRelayV2BrokerCredentialStateStore: openImplementation,
  };
}

function capabilityCase(name) {
  return corpus.nativeInterface.capabilityCases.find((fixture) => fixture.name === name).input;
}

function openCase(name) {
  return corpus.nativeInterface.openCases.find((fixture) => fixture.name === name).input;
}

test("loader snapshots the exact target once and closes hostile target records", async () => {
  let getterReads = 0;
  const accessorTarget = { architecture: "arm64", napiVersion: 9 };
  Object.defineProperty(accessorTarget, "platform", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "darwin";
    },
  });
  let loadCalls = 0;
  const accessorLoader = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
    accessorTarget,
    () => {
      loadCalls += 1;
      return { status: "missing" };
    },
  );
  assert.equal(accessorLoader.capability().status, "invalid");
  assert.equal((await accessorLoader.open("/Users/caller-root")).status, "invalid");
  assert.equal(getterReads, 0);
  assert.equal(loadCalls, 0);

  for (const malformed of [
    { platform: "darwin", architecture: "arm64", napiVersion: 9, artifactPath: "/tmp/x" },
    new Proxy({}, { ownKeys() { throw new Error("target proxy"); } }),
  ]) {
    const closed = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      malformed,
      () => { throw new Error("must not load"); },
    );
    assert.equal(closed.capability().status, "invalid");
    assert.equal((await closed.open("/Users/caller-root")).status, "invalid");
  }

  const mutableTarget = target();
  const captured = [];
  const stable = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
    mutableTarget,
    (artifact) => {
      captured.push(artifact.target);
      return { status: "loaded", binding: binding(SUPPORTED_CAPABILITY) };
    },
  );
  mutableTarget.platform = "win32";
  mutableTarget.architecture = "x64";
  mutableTarget.napiVersion = 1;
  assert.equal(stable.capability().status, "supported");
  assert.deepEqual(captured, ["darwin-arm64"]);
  const opened = await stable.open("/Users/caller-root");
  assert.equal(opened.status, "opened");
  await opened.store.close();
});

test("target and N-API preselection are closed before artifact loading", async () => {
  for (const napiVersion of [9, 8]) {
    const unsupportedTarget = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      target("win32", "x64", napiVersion),
      () => { throw new Error("must not load unsupported target"); },
    );
    assert.deepEqual(unsupportedTarget.capability(), {
      status: "unsupported",
      reason: "target_unsupported",
    });
    assert.deepEqual(await unsupportedTarget.open("C:\\Users\\owner"), {
      status: "unsupported",
      reason: "target_unsupported",
    });
  }

  for (const napiVersion of [8, 9.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    let loadCalls = 0;
    const unsupportedInterface =
      loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
        target("darwin", "arm64", napiVersion),
        () => {
          loadCalls += 1;
          return { status: "missing" };
        },
      );
    assert.deepEqual(unsupportedInterface.capability(), {
      status: "unsupported",
      reason: "interface_version_unsupported",
    });
    assert.equal(loadCalls, 0);
  }
});

test("supported targets expose only their fixed frozen artifact specifier and load once", async () => {
  const cases = [
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["linux", "arm64", "linux-arm64"],
    ["linux", "x64", "linux-x64"],
  ];
  for (const [platform, architecture, artifactTarget] of cases) {
    let loads = 0;
    let capabilityCalls = 0;
    let openCalls = 0;
    const firstBinding = binding(SUPPORTED_CAPABILITY);
    firstBinding.relayV2BrokerCredentialStateCapability = () => {
      capabilityCalls += 1;
      return SUPPORTED_CAPABILITY;
    };
    firstBinding.openRelayV2BrokerCredentialStateStore = (options) => {
      openCalls += 1;
      assert.deepEqual(options, {
        trustedHome: "/Users/caller-owned-root",
        maxStateBytes: stateStore.RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
      });
      assert.equal(Object.isFrozen(options), true);
      return { status: "opened", selfCheck: "passed", store: rawStore() };
    };
    const selected = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      target(platform, architecture),
      (artifact) => {
        loads += 1;
        assert.deepEqual(artifact, {
          target: artifactTarget,
          moduleSpecifier:
            `./native/relay-v2-broker-credential-state-store-v1-${artifactTarget}.node`,
        });
        assert.equal(Object.isFrozen(artifact), true);
        return {
          status: "loaded",
          binding: loads === 1
            ? firstBinding
            : binding({ status: "invalid", error: { code: "STORE_IO" } }),
        };
      },
    );
    const capability = selected.capability();
    assert.equal(capability.status, "supported");
    assert.equal("ready" in capability, false);
    assert.strictEqual(selected.capability(), capability);
    const opened = await selected.open("/Users/caller-owned-root");
    assert.equal(opened.status, "opened");
    assert.equal("ready" in opened, false);
    await opened.store.close();
    assert.equal(loads, 1, `${artifactTarget} binding is loaded once`);
    assert.equal(capabilityCalls, 1, `${artifactTarget} capability is fixed once`);
    assert.equal(openCalls, 1, `${artifactTarget} opens through the cached binding`);
  }
});

test("loader exact-decodes only its missing or loaded result union", async () => {
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
    { status: "missing", fallback: "v1" },
    { status: "loaded" },
    { status: "loaded", binding: binding(SUPPORTED_CAPABILITY), fallback: "v1" },
    accessorResult,
    new Proxy({}, { ownKeys() { throw new Error("load result proxy"); } }),
  ];
  for (const result of malformedResults) {
    const closed = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      target(),
      () => result,
    );
    assert.equal(closed.capability().status, "invalid");
    assert.equal((await closed.open("/Users/caller-root")).status, "invalid");
  }
  assert.equal(statusGetterReads, 0);
});

test("loaded raw binding identity is cached once and decoded only by N0", async () => {
  let bindingGetterReads = 0;
  const accessorBinding = {
    openRelayV2BrokerCredentialStateStore: () => {
      throw new Error("must not open hostile binding");
    },
  };
  Object.defineProperty(accessorBinding, "relayV2BrokerCredentialStateCapability", {
    enumerable: true,
    get() {
      bindingGetterReads += 1;
      return () => SUPPORTED_CAPABILITY;
    },
  });
  const hostileBindings = [
    accessorBinding,
    new Proxy({}, { ownKeys() { throw new Error("binding proxy"); } }),
    {},
  ];
  for (const rawBinding of hostileBindings) {
    let loads = 0;
    const closed = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      target(),
      () => {
        loads += 1;
        return { status: "loaded", binding: rawBinding };
      },
    );
    assert.deepEqual(closed.capability(), {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    });
    assert.deepEqual(await closed.open("/Users/caller-root"), {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    });
    assert.equal(loads, 1);
  }
  assert.equal(bindingGetterReads, 0, "P1a passes the identity to N0 without invoking accessors");
});

test("only fixed-artifact resolve MODULE_NOT_FOUND is optional", async () => {
  const fixedSpecifier =
    "./native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node";
  let resolveCalls = 0;
  let loadCalls = 0;
  const missing = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoaderWithModuleRuntime(
    target(),
    (specifier) => {
      resolveCalls += 1;
      assert.equal(specifier, fixedSpecifier);
      throw Object.assign(new Error("fixed artifact is absent"), {
        code: "MODULE_NOT_FOUND",
      });
    },
    () => {
      loadCalls += 1;
      throw new Error("must not load an unresolved artifact");
    },
  );
  assert.deepEqual(
    missing.capability(),
    { status: "unsupported", reason: "native_artifact_missing" },
  );
  assert.deepEqual(await missing.open("/Users/caller-root"), {
    status: "unsupported",
    reason: "native_artifact_missing",
  });
  assert.equal(resolveCalls, 1);
  assert.equal(loadCalls, 0);
});

test("resolve failures other than self-missing remain closed invalid", async () => {
  const failures = [
    Object.assign(new Error("permission denied at /sensitive/path"), { code: "EACCES" }),
    Object.assign(new Error("resolver initialization exposed /sensitive/path"), {
      code: "ERR_INVALID_ARG_VALUE",
    }),
  ];
  for (const failure of failures) {
    let resolveCalls = 0;
    let loadCalls = 0;
    const closed =
      loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoaderWithModuleRuntime(
        target(),
        (specifier) => {
          resolveCalls += 1;
          assert.equal(
            specifier,
            "./native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node",
          );
          throw failure;
        },
        () => {
          loadCalls += 1;
          throw new Error("must not load after resolver failure");
        },
      );
    const capability = closed.capability();
    assert.deepEqual(capability, {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    });
    assert.doesNotMatch(JSON.stringify(capability), /sensitive|path|permission|resolver/i);
    assert.deepEqual(await closed.open("/Users/caller-root"), capability);
    assert.equal(resolveCalls, 1);
    assert.equal(loadCalls, 0);
  }
});

test("failures after successful fixed-artifact resolution remain closed invalid", async () => {
  const failures = [
    Object.assign(new Error("nested dependency missing at /sensitive/path"), {
      code: "MODULE_NOT_FOUND",
    }),
    Object.assign(new Error("dlopen failed at /sensitive/path"), {
      code: "ERR_DLOPEN_FAILED",
    }),
  ];
  for (const failure of failures) {
    let resolveCalls = 0;
    let loadCalls = 0;
    const closed =
      loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoaderWithModuleRuntime(
        target(),
        (specifier) => {
          resolveCalls += 1;
          assert.equal(
            specifier,
            "./native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node",
          );
          return "fixed-resolved-artifact";
        },
        (resolvedArtifact) => {
          loadCalls += 1;
          assert.equal(resolvedArtifact, "fixed-resolved-artifact");
          throw failure;
        },
      );
    const capability = closed.capability();
    assert.deepEqual(capability, {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    });
    assert.doesNotMatch(JSON.stringify(capability), /sensitive|path|dlopen|permission/i);
    assert.deepEqual(await closed.open("/Users/caller-root"), capability);
    assert.equal(resolveCalls, 1);
    assert.equal(loadCalls, 1, "resolved load failure never tries a fallback artifact");
  }
});

test("N0 closed capability is the only native interface-version decision", async () => {
  const oldInterface = capabilityCase("interface-version-unsupported-before-open");
  let openCalls = 0;
  const unsupported = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
    target(),
    () => ({
      status: "loaded",
      binding: binding(oldInterface, () => {
        openCalls += 1;
        throw new Error("must not open an unsupported native interface");
      }),
    }),
  );
  assert.deepEqual(unsupported.capability(), oldInterface);
  assert.deepEqual(await unsupported.open("/Users/caller-root"), oldInterface);
  assert.equal(openCalls, 0);

  const malformed = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
    target(),
    () => ({
      status: "loaded",
      binding: binding(capabilityCase("partial-capability-is-invalid")),
    }),
  );
  assert.deepEqual(malformed.capability(), {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  });
});

test("open delegates N0 unsupported, invalid, and opened unions without fallback", async () => {
  const cases = [
    "open-pre-open-artifact-missing",
    "open-corrupt-store-is-invalid",
    "opened-self-checked-raw-store",
  ];
  for (const name of cases) {
    let input = structuredClone(openCase(name));
    if (input.store === "materialize-test-store") {
      input = { ...input, store: rawStore() };
    }
    let loads = 0;
    let opens = 0;
    const selected = loaderModule.createRelayV2BrokerCredentialStateStoreNativeLoader(
      target(),
      () => {
        loads += 1;
        return {
          status: "loaded",
          binding: binding(SUPPORTED_CAPABILITY, () => {
            opens += 1;
            return input;
          }),
        };
      },
    );
    const result = await selected.open("/Users/caller-root");
    assert.equal(result.status, name.startsWith("opened") ? "opened" : input.status, name);
    if (result.status === "unsupported") assert.equal(result.reason, input.reason, name);
    if (result.status === "invalid") assert.equal(result.error.code, input.error.code, name);
    if (result.status === "opened") await result.store.close();
    assert.equal(loads, 1, name);
    assert.equal(opens, 1, name);
  }
});
