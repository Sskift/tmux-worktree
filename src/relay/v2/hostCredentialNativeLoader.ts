import { createRequire as createNodeRequire } from "node:module";
import { types as nodeTypes } from "node:util";

import {
  getRelayV2HostCredentialNativeTargetDescriptor,
} from "./hostCredentialNativeTarget.js";
import {
  RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD,
  type RelayV2HostCredentialNativeModuleLoad,
  type RelayV2HostCredentialNativeModuleLoader,
} from "./hostCredentialNativeModuleSource.js";
import {
  takeRelayV2HostSelfHostedDarwinArm64AdmissionPolicy,
  type RelayV2HostSelfHostedDarwinArm64AdmissionPolicy,
} from "./hostSelfHostedDarwinArm64AdmissionPolicy.js";

const DESCRIPTOR_KEYS = Object.freeze([
  "target",
  "platform",
  "architecture",
  "cargoTargetTriple",
] as const);

const TRUSTED_FACTORY_METHOD =
  "createRelayV2HostCredentialAtomicFileCellTrustedFactoryV1" as const;
const SELF_HOSTED_DARWIN_ARM64_FACTORY_METHOD =
  "createRelayV2HostCredentialAtomicFileCellSelfHostedDarwinArm64FactoryV1" as const;

function fixedLoaderFailure(message: string): Error {
  return new Error(`Relay v2 Host credential native module fixed loader: ${message}`);
}

function isModuleNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && Object.getOwnPropertyDescriptor(error, "code")?.value === "MODULE_NOT_FOUND";
}

// Closed own-data snapshot of the holder-issued descriptor. Proxy, accessor,
// symbol key, missing/extra key, and non-string values fail closed with a
// stable redacted error; the loader never reflects on hostile detail.
function snapshotDescriptor(value: unknown): Readonly<{
  target: string;
  platform: string;
  architecture: string;
  cargoTargetTriple: string;
}> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (nodeTypes.isProxy(value)) return null;
  } catch {
    return null;
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== DESCRIPTOR_KEYS.length) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !(DESCRIPTOR_KEYS as readonly string[]).includes(key)) {
      return null;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    if (typeof descriptor.value !== "string") return null;
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as Readonly<{
    target: string;
    platform: string;
    architecture: string;
    cargoTargetTriple: string;
  }>;
}

/**
 * Fixed-mapping module-runtime adapter for the frozen Host credential native
 * artifact identity. It accepts only the holder-issued exact target
 * descriptor, maps its target through the frozen descriptor table to the one
 * fixed loader-relative module specifier, and resolves/loads through the
 * caller-supplied module runtime. Only a MODULE_NOT_FOUND raised while
 * resolving that exact fixed artifact is optional ("missing"); every other
 * resolve failure and every load failure propagates so the holder redacts it
 * to invalid. There is no dynamic scan, alternate candidate, N-API version
 * decision (the holder is its only owner), or env/HOME/JSON/BAU/v1 fallback.
 */
export function createRelayV2HostCredentialNativeModuleFixedLoader(
  resolveArtifact: (fixedModuleSpecifier: string) => string,
  loadResolvedArtifact: (resolvedArtifact: string) => unknown,
): RelayV2HostCredentialNativeModuleLoader {
  if (typeof resolveArtifact !== "function" || typeof loadResolvedArtifact !== "function") {
    throw fixedLoaderFailure("module runtime is invalid");
  }
  return (descriptor) => {
    const snapshot = snapshotDescriptor(descriptor);
    if (snapshot === null) throw fixedLoaderFailure("target descriptor is invalid");
    const fixed = getRelayV2HostCredentialNativeTargetDescriptor(snapshot.target);
    if (fixed === null) throw fixedLoaderFailure("target is unsupported");
    let resolved: string;
    try {
      resolved = resolveArtifact(fixed.loaderModuleSpecifier);
    } catch (error) {
      // Resolution happens before evaluation. Only absence of this exact,
      // fixed mapped artifact is optional; every failure after resolution is
      // an invalid native boundary and must not be disguised as missing.
      if (isModuleNotFound(error)) return Object.freeze({ status: "missing" });
      throw error;
    }
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw fixedLoaderFailure("module runtime returned an invalid artifact identity");
    }
    return Object.freeze({ status: "loaded", binding: loadResolvedArtifact(resolved) });
  };
}

const nativeRequire = createNodeRequire(import.meta.url);

/**
 * Default fixed loader over this module's own Node module runtime. It resolves
 * the one frozen loader-relative specifier next to this dist entry; it is a
 * narrow source a trusted deployment may explicitly select, never a
 * qualification, readiness, or capability claim.
 */
export const relayV2HostCredentialNativeModuleFixedLoader:
  RelayV2HostCredentialNativeModuleLoader =
  createRelayV2HostCredentialNativeModuleFixedLoader(
    (fixedModuleSpecifier) => nativeRequire.resolve(fixedModuleSpecifier),
    (resolvedArtifact) => nativeRequire(resolvedArtifact),
  );

function trustedLoaderFailure(message: string): Error {
  return new Error(`Relay v2 Host credential native module trusted loader: ${message}`);
}

function isClosedFunction(value: unknown): boolean {
  try {
    return typeof value === "function"
      && !nodeTypes.isProxy(value)
      && !nodeTypes.isAsyncFunction(value);
  } catch {
    return false;
  }
}

// Closed own-data capture shared by every trusted-factory boundary record:
// plain prototype, exact string keys, data descriptors only, no Proxy. It
// never invokes or reflects on hostile values.
function snapshotClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (nodeTypes.isProxy(value)) return null;
  } catch {
    return null;
  }
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.includes(key)) return null;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

// The raw artifact keeps the frozen v1 module surface exactly `{ open }`: the
// trusted factory rides as an additive own-data entry on the raw open
// function, and this fixed trusted loader is its only production driver (no
// visibility isolation exists or is claimed). The raw open export is never
// invoked or delivered here; only the factory is captured.
function captureRawFactory(
  artifact: unknown,
  factoryMethod: typeof TRUSTED_FACTORY_METHOD
    | typeof SELF_HOSTED_DARWIN_ARM64_FACTORY_METHOD,
): ((...args: never[]) => unknown) | null {
  const snapshot = snapshotClosedRecord(artifact, [
    RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD,
  ]);
  if (snapshot === null) return null;
  const open = snapshot[RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD];
  if (!isClosedFunction(open)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(open, factoryMethod);
  } catch {
    return null;
  }
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
  if (!isClosedFunction(descriptor.value)) return null;
  return descriptor.value as (...args: never[]) => unknown;
}

function captureFactoryReadyBind(result: unknown): ((...args: never[]) => unknown) | null {
  const snapshot = snapshotClosedRecord(result, ["outcome", "bind"]);
  if (snapshot === null || snapshot.outcome !== "ready") return null;
  if (!isClosedFunction(snapshot.bind)) return null;
  return snapshot.bind as (...args: never[]) => unknown;
}

function captureBoundModule(result: unknown): unknown | null {
  const snapshot = snapshotClosedRecord(result, ["outcome", "module"]);
  if (snapshot === null || snapshot.outcome !== "bound") return null;
  const module = snapshotClosedRecord(snapshot.module, [
    RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD,
  ]);
  if (module === null) return null;
  const open = module[RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD];
  if (!isClosedFunction(open)) return null;
  // The final module never carries the factory: its open function must not
  // expose the private trusted entry either.
  try {
    if (Object.getOwnPropertyDescriptor(open, TRUSTED_FACTORY_METHOD) !== undefined
      || Object.getOwnPropertyDescriptor(
        open,
        SELF_HOSTED_DARWIN_ARM64_FACTORY_METHOD,
      ) !== undefined) return null;
  } catch {
    return null;
  }
  return snapshot.module;
}

/**
 * Fixed trusted loader for the contract revision 7 trusted factory v1. It is
 * the factory's only production driver: after the same fixed-target
 * resolve/load as the fixed loader, it captures the factory entry from the
 * raw open function, drives it exactly once with no arguments, consumes the
 * minted capability through the one-shot binder, and delivers only the final
 * exact own-data `{ open }` v1 module as the binding. The factory result, the
 * binder, and the capability are consumed inside this drive and never
 * delivered; the final module never carries the factory entry. Every
 * factory/binder failure, replay, or hostile shape throws redacted so the
 * holder settles invalid; the loader never falls back to the raw v1 module
 * and never routes between the two. No path, descriptor, HOME, environment,
 * or credential is accepted from JavaScript anywhere on this path.
 */
export function createRelayV2HostCredentialNativeModuleTrustedLoader(
  resolveArtifact: (fixedModuleSpecifier: string) => string,
  loadResolvedArtifact: (resolvedArtifact: string) => unknown,
): RelayV2HostCredentialNativeModuleLoader {
  if (typeof resolveArtifact !== "function" || typeof loadResolvedArtifact !== "function") {
    throw trustedLoaderFailure("module runtime is invalid");
  }
  return (descriptor) => {
    const snapshot = snapshotDescriptor(descriptor);
    if (snapshot === null) throw trustedLoaderFailure("target descriptor is invalid");
    const fixed = getRelayV2HostCredentialNativeTargetDescriptor(snapshot.target);
    if (fixed === null) throw trustedLoaderFailure("target is unsupported");
    let resolved: string;
    try {
      resolved = resolveArtifact(fixed.loaderModuleSpecifier);
    } catch (error) {
      // Resolution happens before evaluation. Only absence of this exact,
      // fixed mapped artifact is optional; every failure after resolution is
      // an invalid native boundary and must not be disguised as missing.
      if (isModuleNotFound(error)) return Object.freeze({ status: "missing" });
      throw error;
    }
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw trustedLoaderFailure("module runtime returned an invalid artifact identity");
    }
    const artifact = loadResolvedArtifact(resolved);
    const factory = captureRawFactory(artifact, TRUSTED_FACTORY_METHOD);
    if (factory === null) throw trustedLoaderFailure("raw artifact surface is invalid");
    let factoryResult: unknown;
    try {
      factoryResult = Reflect.apply(factory, undefined, []);
    } catch {
      throw trustedLoaderFailure("trusted factory call failed");
    }
    const bind = captureFactoryReadyBind(factoryResult);
    if (bind === null) throw trustedLoaderFailure("trusted factory result is invalid");
    let bindResult: unknown;
    try {
      bindResult = Reflect.apply(bind, undefined, []);
    } catch {
      throw trustedLoaderFailure("trusted factory bind failed");
    }
    const module = captureBoundModule(bindResult);
    if (module === null) throw trustedLoaderFailure("trusted factory module is invalid");
    return Object.freeze({ status: "loaded", binding: module });
  };
}

/**
 * Default fixed trusted loader over this module's own Node module runtime. It
 * resolves the same one frozen loader-relative specifier as the fixed loader
 * and drives the trusted factory exactly once per delivered module; it is a
 * narrow source a trusted deployment may explicitly select, never a
 * qualification, readiness, or capability claim.
 */
export const relayV2HostCredentialNativeModuleTrustedLoader:
  RelayV2HostCredentialNativeModuleLoader =
  createRelayV2HostCredentialNativeModuleTrustedLoader(
    (fixedModuleSpecifier) => nativeRequire.resolve(fixedModuleSpecifier),
    (resolvedArtifact) => nativeRequire(resolvedArtifact),
  );

function selfHostedLoaderFailure(message: string): Error {
  return new Error(
    `Relay v2 Host credential native module self-hosted Darwin arm64 loader: ${message}`,
  );
}

/**
 * Testable module-runtime adapter for the explicit non-production self-hosted
 * Darwin arm64 policy. The ticket is consumed at construction, before target
 * resolution. The returned loader still accepts only the holder-issued exact
 * Darwin arm64 descriptor and drives only the independent native self-hosted
 * factory. It never invokes the production factory or raw open and has no JS,
 * v1, production, or alternate-artifact fallback.
 */
export function createRelayV2HostCredentialNativeModuleSelfHostedDarwinArm64LoaderForRuntime(
  policy: RelayV2HostSelfHostedDarwinArm64AdmissionPolicy,
  resolveArtifact: (fixedModuleSpecifier: string) => string,
  loadResolvedArtifact: (resolvedArtifact: string) => unknown,
): RelayV2HostCredentialNativeModuleLoader {
  if (arguments.length !== 3) throw selfHostedLoaderFailure("module runtime is invalid");
  takeRelayV2HostSelfHostedDarwinArm64AdmissionPolicy(policy);
  if (typeof resolveArtifact !== "function" || typeof loadResolvedArtifact !== "function") {
    throw selfHostedLoaderFailure("module runtime is invalid");
  }
  return (descriptor) => {
    const snapshot = snapshotDescriptor(descriptor);
    if (snapshot === null
      || snapshot.target !== "darwin-arm64"
      || snapshot.platform !== "darwin"
      || snapshot.architecture !== "arm64"
      || snapshot.cargoTargetTriple !== "aarch64-apple-darwin") {
      throw selfHostedLoaderFailure("target descriptor is invalid");
    }
    const fixed = getRelayV2HostCredentialNativeTargetDescriptor("darwin-arm64");
    if (fixed === null) throw selfHostedLoaderFailure("target is unsupported");
    let resolved: string;
    try {
      resolved = resolveArtifact(fixed.loaderModuleSpecifier);
    } catch (error) {
      if (isModuleNotFound(error)) return Object.freeze({ status: "missing" });
      throw error;
    }
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw selfHostedLoaderFailure("module runtime returned an invalid artifact identity");
    }
    const artifact = loadResolvedArtifact(resolved);
    const factory = captureRawFactory(
      artifact,
      SELF_HOSTED_DARWIN_ARM64_FACTORY_METHOD,
    );
    if (factory === null) throw selfHostedLoaderFailure("raw artifact surface is invalid");
    let factoryResult: unknown;
    try {
      factoryResult = Reflect.apply(factory, undefined, []);
    } catch {
      throw selfHostedLoaderFailure("self-hosted factory call failed");
    }
    const bind = captureFactoryReadyBind(factoryResult);
    if (bind === null) throw selfHostedLoaderFailure("self-hosted factory result is invalid");
    let bindResult: unknown;
    try {
      bindResult = Reflect.apply(bind, undefined, []);
    } catch {
      throw selfHostedLoaderFailure("self-hosted factory bind failed");
    }
    const module = captureBoundModule(bindResult);
    if (module === null) throw selfHostedLoaderFailure("self-hosted factory module is invalid");
    return Object.freeze({ status: "loaded", binding: module });
  };
}

/** Fixed self-hosted loader over this entry's canonical module identity. */
export function createRelayV2HostCredentialNativeModuleSelfHostedDarwinArm64Loader(
  policy: RelayV2HostSelfHostedDarwinArm64AdmissionPolicy,
): RelayV2HostCredentialNativeModuleLoader {
  if (arguments.length !== 1) throw selfHostedLoaderFailure("policy is invalid");
  return createRelayV2HostCredentialNativeModuleSelfHostedDarwinArm64LoaderForRuntime(
    policy,
    (fixedModuleSpecifier) => nativeRequire.resolve(fixedModuleSpecifier),
    (resolvedArtifact) => nativeRequire(resolvedArtifact),
  );
}
