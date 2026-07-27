import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import test from "node:test";

const targetModule = await import("../dist/relay/v2/hostCredentialNativeTarget.js");
const loaderModule = await import("../dist/relay/v2/hostCredentialNativeLoader.js");
const sourceModule = await import("../dist/relay/v2/hostCredentialNativeModuleSource.js");

const fixture = JSON.parse(readFileSync(
  new URL(
    "../contracts/relay/v2/host-credential-atomic-file-cell-v1/native-artifact-cases-v1.json",
    import.meta.url,
  ),
  "utf8",
));

const OPEN_METHOD = "openRelayV2HostCredentialAtomicFileCellV1";
const CONTRACT_REVISION =
  sourceModule.RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_CONTRACT_REVISION;

function holderDescriptor(target, platform, architecture, cargoTargetTriple) {
  return Object.freeze({ target, platform, architecture, cargoTargetTriple });
}

function darwinArm64Descriptor() {
  return holderDescriptor("darwin-arm64", "darwin", "arm64", "aarch64-apple-darwin");
}

function createSource(loader, target = {
  platform: "darwin",
  architecture: "arm64",
  napiVersion: 9,
}) {
  return sourceModule.createRelayV2HostCredentialNativeModuleSource(target, loader);
}

const loaderCasesByName = new Map(fixture.loaderCases.map((entry) => [entry.name, entry]));

test("fixed loader maps each frozen target to its exact specifier with one resolve and one load", () => {
  for (const canonical of fixture.canonicalTargets) {
    const resolvedIdentity = `/resolved/${canonical.runtimeArtifactFileName}`;
    const binding = { [OPEN_METHOD]() {} };
    const calls = [];
    const loader = loaderModule.createRelayV2HostCredentialNativeModuleFixedLoader(
      (specifier) => {
        calls.push(["resolve", specifier]);
        return resolvedIdentity;
      },
      (resolved) => {
        calls.push(["load", resolved]);
        return binding;
      },
    );
    const result = loader(holderDescriptor(
      canonical.target,
      canonical.platform,
      canonical.architecture,
      canonical.cargoTargetTriple,
    ));
    assert.deepEqual(calls, [
      ["resolve", canonical.loaderModuleSpecifier],
      ["load", resolvedIdentity],
    ], `${canonical.target}: exactly one fixed-candidate resolve and one load`);
    assert.deepEqual(result, { status: "loaded", binding }, canonical.target);
    assert.equal(Object.isFrozen(result), true, canonical.target);
    assert.strictEqual(result.binding, binding, canonical.target);
  }
});

test("fixed loader rejects hostile or unknown descriptors closed before any resolve", () => {
  let resolveCalls = 0;
  const loader = loaderModule.createRelayV2HostCredentialNativeModuleFixedLoader(
    () => {
      resolveCalls += 1;
      return "/resolved/must-not-happen.node";
    },
    () => ({}),
  );
  const rejected = [
    ["unknown target", holderDescriptor("windows-x64", "win32", "x64", "x86_64-pc-windows-msvc")],
    ["extra fallback key", {
      target: "darwin-arm64",
      platform: "darwin",
      architecture: "arm64",
      cargoTargetTriple: "aarch64-apple-darwin",
      fallback: "./alternate.node",
    }],
    ["missing key", { target: "darwin-arm64", platform: "darwin", architecture: "arm64" }],
    ["accessor field", Object.defineProperty({}, "target", {
      enumerable: true,
      get() { return "darwin-arm64"; },
    })],
    ["proxy descriptor", new Proxy({}, {})],
    ["null", null],
    ["array", ["darwin-arm64"]],
    ["non-string field", {
      target: "darwin-arm64",
      platform: "darwin",
      architecture: "arm64",
      cargoTargetTriple: 1,
    }],
  ];
  for (const [label, descriptor] of rejected) {
    assert.throws(
      () => loader(descriptor),
      /^Error: Relay v2 Host credential native module fixed loader: /,
      label,
    );
  }
  assert.equal(resolveCalls, 0, "a rejected descriptor never resolves a candidate");
});

test("only the fixed artifact's own resolve-stage MODULE_NOT_FOUND maps to missing", () => {
  const missingCase = loaderCasesByName.get(
    "fixed-artifact-resolve-missing-is-native-artifact-missing",
  );
  assert.equal(missingCase.expectedLoaderOutcome, "missing");
  const calls = [];
  const loader = loaderModule.createRelayV2HostCredentialNativeModuleFixedLoader(
    (specifier) => {
      calls.push(["resolve", specifier]);
      throw Object.assign(new Error("fixed artifact is absent at /sensitive/path"), {
        code: missingCase.resolveErrorCode,
      });
    },
    (resolved) => {
      calls.push(["load", resolved]);
      throw new Error("must not load an unresolved artifact");
    },
  );
  const result = loader(darwinArm64Descriptor());
  assert.deepEqual(result, { status: "missing" });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls, [[
    "resolve",
    "./native/relay-v2-host-credential-atomic-file-cell-v1-darwin-arm64.node",
  ]]);

  // Through the holder this stays an unsupported, memoized, never-retried
  // native_artifact_missing instead of an invalid boundary.
  const source = createSource(loader);
  const capability = source.capability();
  assert.deepEqual(capability, missingCase.expectedHolderCapability);
  assert.strictEqual(source.capability(), capability, "missing selection is memoized");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => source.takeNativeModule(),
      (error) => error?.code === "NATIVE_ARTIFACT_MISSING",
    );
  }
  assert.deepEqual(calls.filter(([kind]) => kind === "resolve").length, 2);
});

test("resolve and load failures after selection stay redacted invalid through the holder", () => {
  for (const name of [
    "resolve-failure-is-redacted-invalid",
    "load-failure-is-redacted-invalid",
    "invalid-resolved-identity-is-redacted-invalid",
  ]) {
    const entry = loaderCasesByName.get(name);
    assert.equal(entry.expectedLoaderOutcome, "throw", name);
    const expectLoad = entry.loadErrorCode !== undefined;
    let resolveCalls = 0;
    let loadCalls = 0;
    const loader = loaderModule.createRelayV2HostCredentialNativeModuleFixedLoader(
      (specifier) => {
        resolveCalls += 1;
        assert.equal(
          specifier,
          "./native/relay-v2-host-credential-atomic-file-cell-v1-darwin-arm64.node",
        );
        if (entry.resolveErrorCode !== undefined) {
          throw Object.assign(new Error("resolve exposed /sensitive/path token twhostboot2.x"), {
            code: entry.resolveErrorCode,
          });
        }
        return entry.resolvedIdentity ?? "/resolved/fixed.node";
      },
      () => {
        loadCalls += 1;
        throw Object.assign(new Error("dlopen exposed /sensitive/path"), {
          code: entry.loadErrorCode,
        });
      },
    );
    // None of these failures are disguised as a missing artifact: the fixed
    // loader propagates them and never retries an alternate candidate.
    assert.throws(() => loader(darwinArm64Descriptor()), undefined, name);

    const source = createSource(loader);
    const capability = source.capability();
    assert.deepEqual(capability, entry.expectedHolderCapability, name);
    assert.doesNotMatch(JSON.stringify(capability), /sensitive|dlopen|twhostboot2/i, name);
    assert.throws(
      () => source.takeNativeModule(),
      (error) => {
        assert.equal(error?.code, "SOURCE_INVALID");
        assert.doesNotMatch(String(error), /sensitive|dlopen|twhostboot2/i);
        return true;
      },
      name,
    );
    assert.equal(resolveCalls, 2, `${name}: one direct call plus one memoized holder call`);
    assert.equal(loadCalls, expectLoad ? 2 : 0, name);
  }
});

test("fixed loader and holder integrate over a fake module runtime exactly once", () => {
  const resolvedIdentity =
    "/fake/relay-v2-host-credential-atomic-file-cell-v1-darwin-arm64.node";
  const nativeModule = Object.freeze({
    [OPEN_METHOD]() {
      return {
        abiVersion: 1,
        operation: "open",
        outcome: "error",
        error: { code: "CELL_DURABILITY_UNSUPPORTED" },
      };
    },
  });
  let resolveCalls = 0;
  let loadCalls = 0;
  const source = createSource(
    loaderModule.createRelayV2HostCredentialNativeModuleFixedLoader(
      (specifier) => {
        resolveCalls += 1;
        assert.equal(
          specifier,
          "./native/relay-v2-host-credential-atomic-file-cell-v1-darwin-arm64.node",
        );
        return resolvedIdentity;
      },
      (resolved) => {
        loadCalls += 1;
        assert.equal(resolved, resolvedIdentity);
        return nativeModule;
      },
    ),
  );
  const capability = source.capability();
  assert.deepEqual(capability, {
    status: "supported",
    target: "darwin-arm64",
    platform: "darwin",
    architecture: "arm64",
    contractRevision: CONTRACT_REVISION,
    abi: "napi",
    abiVersion: 1,
  });
  assert.equal("ready" in capability, false, "supported is never a readiness result");
  assert.strictEqual(source.capability(), capability, "capability is memoized");
  const taken = source.takeNativeModule();
  assert.strictEqual(taken, nativeModule, "the exact loaded identity is delivered once");
  assert.throws(
    () => source.takeNativeModule(),
    (error) => error?.code === "SOURCE_CONSUMED",
  );
  assert.equal(resolveCalls, 1, "fixed candidate resolved exactly once");
  assert.equal(loadCalls, 1, "fixed candidate loaded exactly once");
});

test("default fixed loader resolves the current target missing without a staged artifact", () => {  const descriptor = targetModule.selectRelayV2HostCredentialNativeTargetDescriptor(
    process.platform,
    process.arch,
  );
  const source = createSource(
    loaderModule.relayV2HostCredentialNativeModuleFixedLoader,
    {
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    },
  );
  if (descriptor === null) {
    assert.deepEqual(source.capability(), {
      status: "unsupported",
      reason: "target_unsupported",
    });
    return;
  }
  const staged = new URL(
    `../dist/relay/v2/native/${descriptor.runtimeArtifactFileName}`,
    import.meta.url,
  );
  if (existsSync(staged)) {
    // An explicit opt-in stage left the real artifact in place; the loaded
    // path is covered by the env-gated binding test instead of this case.
    return;
  }
  let capability;
  assert.doesNotThrow(() => {
    capability = source.capability();
  });
  assert.deepEqual(capability, {
    status: "unsupported",
    reason: "native_artifact_missing",
  });
  assert.throws(
    () => source.takeNativeModule(),
    (error) => error?.code === "NATIVE_ARTIFACT_MISSING",
  );
});

const TRUSTED_FACTORY_METHOD = "createRelayV2HostCredentialAtomicFileCellTrustedFactoryV1";

function fakeFinalModule(openResult) {
  return Object.freeze({
    [OPEN_METHOD]() {
      return openResult;
    },
  });
}

function fakeRawArtifact({ factoryResult, bindResult, onFactory }) {
  const module = fakeFinalModule({
    abiVersion: 1,
    operation: "open",
    outcome: "error",
    error: { code: "CELL_DURABILITY_UNSUPPORTED" },
  });
  const open = () => {
    throw new Error("raw open export must never be invoked by the trusted loader");
  };
  // The frozen v1 surface stays exactly `{ open }`: the factory rides as an
  // additive own-data entry on the raw open function.
  Object.defineProperty(open, TRUSTED_FACTORY_METHOD, {
    value: () => {
      onFactory?.();
      if (factoryResult !== undefined) return factoryResult;
      return Object.freeze({
        outcome: "ready",
        bind: Object.freeze(() => {
          if (bindResult !== undefined) return bindResult;
          return Object.freeze({ outcome: "bound", module });
        }),
      });
    },
    enumerable: true,
  });
  return Object.freeze({ [OPEN_METHOD]: open });
}

function trustedLoaderWith(artifact, calls) {
  return loaderModule.createRelayV2HostCredentialNativeModuleTrustedLoader(
    (specifier) => {
      calls.push(["resolve", specifier]);
      return "/resolved/trusted.node";
    },
    (resolved) => {
      calls.push(["load", resolved]);
      return artifact;
    },
  );
}

test("trusted loader drives the factory exactly once and delivers only the final module", () => {
  const calls = [];
  let factoryCalls = 0;
  const artifact = fakeRawArtifact({ onFactory: () => { factoryCalls += 1; } });
  const source = createSource(trustedLoaderWith(artifact, calls));
  const capability = source.capability();
  assert.deepEqual(capability, {
    status: "supported",
    target: "darwin-arm64",
    platform: "darwin",
    architecture: "arm64",
    contractRevision: CONTRACT_REVISION,
    abi: "napi",
    abiVersion: 1,
  });
  const taken = source.takeNativeModule();
  assert.notStrictEqual(taken, artifact, "the raw artifact is never delivered");
  assert.deepEqual(Reflect.ownKeys(taken), [OPEN_METHOD], "final module carries only open");
  assert.equal(Object.hasOwn(taken, TRUSTED_FACTORY_METHOD), false);
  assert.equal(
    Object.getOwnPropertyDescriptor(taken[OPEN_METHOD], TRUSTED_FACTORY_METHOD),
    undefined,
    "the final module's open never carries the trusted factory entry",
  );
  assert.deepEqual(taken[OPEN_METHOD]({ abiVersion: 1, operation: "open" }), {
    abiVersion: 1,
    operation: "open",
    outcome: "error",
    error: { code: "CELL_DURABILITY_UNSUPPORTED" },
  });
  assert.equal(factoryCalls, 1, "factory driven exactly once");
  assert.deepEqual(calls, [
    ["resolve", "./native/relay-v2-host-credential-atomic-file-cell-v1-darwin-arm64.node"],
    ["load", "/resolved/trusted.node"],
  ]);
});

test("trusted loader fails closed on factory error, bind replay, and hostile shapes", () => {
  const cases = [
    ["factory closed error result", fakeRawArtifact({
      factoryResult: Object.freeze({ outcome: "error", error: Object.freeze({ code: "CELL_IO" }) }),
    })],
    ["bind replay closed error result", fakeRawArtifact({
      bindResult: Object.freeze({ outcome: "error", error: Object.freeze({ code: "CELL_CLOSED" }) }),
    })],
    ["factory result with extra key", fakeRawArtifact({
      factoryResult: Object.freeze({
        outcome: "ready",
        bind: Object.freeze(() => ({})),
        fallback: Object.freeze({}),
      }),
    })],
    ["bound module with factory side by side", fakeRawArtifact({
      bindResult: Object.freeze({
        outcome: "bound",
        module: Object.freeze({
          [OPEN_METHOD]() {},
          [TRUSTED_FACTORY_METHOD]() {},
        }),
      }),
    })],
    ["bound module open carries the factory entry", fakeRawArtifact({
      bindResult: (() => {
        const open = () => {};
        Object.defineProperty(open, TRUSTED_FACTORY_METHOD, {
          value: () => ({}),
          enumerable: true,
        });
        return Object.freeze({
          outcome: "bound",
          module: Object.freeze({ [OPEN_METHOD]: open }),
        });
      })(),
    })],
    ["artifact missing the factory entry", Object.freeze({ [OPEN_METHOD]() {} })],
    ["artifact with an extra export", Object.freeze({
      [OPEN_METHOD]() {},
      [TRUSTED_FACTORY_METHOD]() {},
      alternate() {},
    })],
    ["artifact factory as accessor", (() => {
      const open = () => {};
      Object.defineProperty(open, TRUSTED_FACTORY_METHOD, {
        enumerable: true,
        get() { return () => ({}); },
      });
      return Object.freeze({ [OPEN_METHOD]: open });
    })()],
    ["factory result is a proxy", fakeRawArtifact({ factoryResult: new Proxy({}, {}) })],
  ];
  for (const [label, artifact] of cases) {
    const calls = [];
    const loader = trustedLoaderWith(artifact, calls);
    assert.throws(
      () => loader(darwinArm64Descriptor()),
      /^Error: Relay v2 Host credential native module trusted loader: /,
      label,
    );
    const source = createSource(loader);
    const capability = source.capability();
    assert.deepEqual(capability, {
      status: "invalid",
      error: { code: "NATIVE_INTERFACE_INVALID" },
    }, label);
    assert.doesNotMatch(JSON.stringify(capability), /CELL_IO|CELL_CLOSED/, label);
    assert.throws(
      () => source.takeNativeModule(),
      (error) => error?.code === "SOURCE_INVALID",
      label,
    );
  }
});

test("trusted loader never falls back to the raw v1 module", () => {
  // A closed factory error is redacted to invalid; the raw `{ open }` module
  // riding the same artifact is never delivered as a fallback.
  const artifact = fakeRawArtifact({
    factoryResult: Object.freeze({
      outcome: "error",
      error: Object.freeze({ code: "CELL_IO" }),
    }),
  });
  const source = createSource(trustedLoaderWith(artifact, []));
  assert.deepEqual(source.capability(), {
    status: "invalid",
    error: { code: "NATIVE_INTERFACE_INVALID" },
  });
  assert.throws(
    () => source.takeNativeModule(),
    (error) => error?.code === "SOURCE_INVALID",
  );
});
