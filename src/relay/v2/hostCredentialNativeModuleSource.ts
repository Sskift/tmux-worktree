import { types as nodeTypes } from "node:util";

export const RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_CONTRACT_REVISION = 5 as const;
export const RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI = "napi" as const;
export const RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI_VERSION = 1 as const;
export const RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_MINIMUM_NAPI_VERSION = 9 as const;
export const RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD =
  "openRelayV2HostCredentialAtomicFileCellV1" as const;

export type RelayV2HostCredentialNativeModuleSupportedTarget =
  | "darwin-arm64"
  | "linux-x64";

export interface RelayV2HostCredentialNativeModuleTarget {
  readonly platform: string;
  readonly architecture: string;
  readonly napiVersion: number;
}

// Contract facts only. Each descriptor mirrors one entry of the frozen
// manifest's platformResources.targetFacts.validatedTargets (Darwin
// aarch64-apple-darwin, Linux x86_64-unknown-linux-gnu); there is no wildcard,
// alternate candidate, or caller override. The frozen contract freezes no
// artifact descriptor, digest, or layout, so these descriptors deliberately
// carry no module specifier, path, or artifact identity.
export interface RelayV2HostCredentialNativeModuleTargetDescriptor {
  readonly target: RelayV2HostCredentialNativeModuleSupportedTarget;
  readonly platform: "darwin" | "linux";
  readonly architecture: "arm64" | "x64";
  readonly cargoTargetTriple: "aarch64-apple-darwin" | "x86_64-unknown-linux-gnu";
}

const TARGET_DESCRIPTORS: Readonly<
  Record<
    RelayV2HostCredentialNativeModuleSupportedTarget,
    RelayV2HostCredentialNativeModuleTargetDescriptor
  >
> = Object.freeze({
  "darwin-arm64": Object.freeze({
    target: "darwin-arm64" as const,
    platform: "darwin" as const,
    architecture: "arm64" as const,
    cargoTargetTriple: "aarch64-apple-darwin" as const,
  }),
  "linux-x64": Object.freeze({
    target: "linux-x64" as const,
    platform: "linux" as const,
    architecture: "x64" as const,
    cargoTargetTriple: "x86_64-unknown-linux-gnu" as const,
  }),
});

export type RelayV2HostCredentialNativeModuleUnsupportedReason =
  | "native_artifact_missing"
  | "target_unsupported"
  | "interface_version_unsupported";

export type RelayV2HostCredentialNativeModuleCapability =
  | Readonly<{
    status: "supported";
    target: RelayV2HostCredentialNativeModuleSupportedTarget;
    platform: "darwin" | "linux";
    architecture: "arm64" | "x64";
    contractRevision: typeof RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_CONTRACT_REVISION;
    abi: typeof RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI;
    abiVersion: typeof RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI_VERSION;
  }>
  | Readonly<{
    status: "unsupported";
    reason: RelayV2HostCredentialNativeModuleUnsupportedReason;
  }>
  | Readonly<{
    status: "invalid";
    error: Readonly<{ code: "NATIVE_INTERFACE_INVALID" }>;
  }>;

/**
 * Injected seam. The source chooses the frozen exact target descriptor and
 * hands it to the loader; callers cannot supply a module path, an artifact
 * specifier, or an alternate/fallback candidate, and this foundation does not
 * define where a real module would come from.
 */
export type RelayV2HostCredentialNativeModuleLoad =
  | Readonly<{ status: "loaded"; binding: unknown }>
  | Readonly<{ status: "missing" }>;

export type RelayV2HostCredentialNativeModuleLoader = (
  target: RelayV2HostCredentialNativeModuleTargetDescriptor,
) => RelayV2HostCredentialNativeModuleLoad;

export type RelayV2HostCredentialNativeModuleSourceErrorCode =
  | "SOURCE_INVALID"
  | "TARGET_UNSUPPORTED"
  | "INTERFACE_VERSION_UNSUPPORTED"
  | "NATIVE_ARTIFACT_MISSING"
  | "SOURCE_CONSUMED"
  | "SOURCE_CLOSED";

const ERROR_MESSAGES: Readonly<
  Record<RelayV2HostCredentialNativeModuleSourceErrorCode, string>
> = Object.freeze({
  SOURCE_INVALID: "Relay v2 Host credential native module source is invalid",
  TARGET_UNSUPPORTED: "Relay v2 Host credential native module target is unsupported",
  INTERFACE_VERSION_UNSUPPORTED:
    "Relay v2 Host credential native module interface version is unsupported",
  NATIVE_ARTIFACT_MISSING: "Relay v2 Host credential native module artifact is missing",
  SOURCE_CONSUMED: "Relay v2 Host credential native module source is consumed",
  SOURCE_CLOSED: "Relay v2 Host credential native module source is closed",
});

export class RelayV2HostCredentialNativeModuleSourceError extends Error {
  constructor(
    readonly code: RelayV2HostCredentialNativeModuleSourceErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostCredentialNativeModuleSourceError";
  }
}

function failure(
  code: RelayV2HostCredentialNativeModuleSourceErrorCode,
): RelayV2HostCredentialNativeModuleSourceError {
  return new RelayV2HostCredentialNativeModuleSourceError(code);
}

export interface RelayV2HostCredentialNativeModuleSource {
  /**
   * Exact target/contract-revision/ABI support only. This is never a
   * readiness, durability-qualification, or capability-advertisement result:
   * even a supported source only means the injected loader produced a module
   * for the exact target that exposed the frozen ABI shape. It is memoized;
   * close() never re-probes, and a closed-before-probe source reports invalid
   * instead of loading.
   */
  capability(): RelayV2HostCredentialNativeModuleCapability;

  /**
   * One-shot synchronous ownership transfer of the exact loaded module
   * identity (the original receiver, never a copy or wrapper). The first
   * supported take delivers the module and permanently consumes this source;
   * every later take fails closed. The source never calls the module open
   * method: cell open, raw-handle ownership, and decode stay with the
   * existing canonical native wrapper and bridge.
   */
  takeNativeModule(): unknown;

  /**
   * Bounded fail-closed recycle. Before delivery it permanently fences take
   * and drops the only owned module reference; after delivery it is a no-op
   * because ownership has transferred. It never retries, reloads, picks a
   * fallback candidate, or touches the delivered module.
   */
  close(): void;
}

type Selection = Readonly<{
  capability: RelayV2HostCredentialNativeModuleCapability;
  binding?: unknown;
}>;

function invalidCapability(): RelayV2HostCredentialNativeModuleCapability {
  return Object.freeze({
    status: "invalid",
    error: Object.freeze({ code: "NATIVE_INTERFACE_INVALID" as const }),
  });
}

function unsupportedCapability(
  reason: RelayV2HostCredentialNativeModuleUnsupportedReason,
): RelayV2HostCredentialNativeModuleCapability {
  return Object.freeze({ status: "unsupported", reason });
}

function supportedCapability(
  descriptor: RelayV2HostCredentialNativeModuleTargetDescriptor,
): RelayV2HostCredentialNativeModuleCapability {
  return Object.freeze({
    status: "supported",
    target: descriptor.target,
    platform: descriptor.platform,
    architecture: descriptor.architecture,
    contractRevision: RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_CONTRACT_REVISION,
    abi: RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI,
    abiVersion: RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_ABI_VERSION,
  });
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function snapshotExactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const allowed = [...required, ...optional];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) return null;
  if (required.some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !Object.hasOwn(descriptor, "value");
  })) return null;
  for (const key of optional) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && !Object.hasOwn(descriptor, "value")) return null;
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined && descriptor.value !== undefined) {
      result[key] = descriptor.value;
    }
  }
  return Object.freeze(result);
}

function isNativeAsyncFunction(value: unknown): boolean {
  try {
    return typeof value !== "function"
      || rejectedProxy(value)
      || nodeTypes.isAsyncFunction(value);
  } catch {
    return true;
  }
}

function snapshotTarget(
  value: unknown,
): Readonly<RelayV2HostCredentialNativeModuleTarget> | null {
  const snapshot = snapshotExactDataRecord(
    value,
    ["platform", "architecture", "napiVersion"],
  );
  if (snapshot === null
    || typeof snapshot.platform !== "string"
    || typeof snapshot.architecture !== "string") return null;
  return Object.freeze({
    platform: snapshot.platform,
    architecture: snapshot.architecture,
    napiVersion: snapshot.napiVersion as number,
  });
}

function decodeNativeModuleLoad(
  value: unknown,
): RelayV2HostCredentialNativeModuleLoad | null {
  const snapshot = snapshotExactDataRecord(value, ["status"], ["binding"]);
  if (snapshot === null || typeof snapshot.status !== "string") return null;
  if (snapshot.status === "missing" && snapshot.binding === undefined) {
    return Object.freeze({ status: "missing" });
  }
  if (snapshot.status === "loaded" && snapshot.binding !== undefined) {
    return Object.freeze({ status: "loaded", binding: snapshot.binding });
  }
  return null;
}

// Mirrors the canonical wrapper's thenable fence: any own `then` accessor or
// function anywhere on the prototype chain makes the value asynchronous and
// inadmissible, without invoking or assimilating it.
function hasThenablePrototypeChain(value: object): boolean {
  try {
    let current: object | null = value;
    while (current !== null) {
      if (nodeTypes.isProxy(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, "then");
      if (descriptor !== undefined) {
        return descriptor.get !== undefined || typeof descriptor.value === "function";
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Frozen ABI admission: the module must be a plain exact own-data record
 * whose only property is the frozen synchronous open method. The original
 * identity is returned unchanged so the wrapper keeps the real receiver;
 * Proxy, accessor, symbol key, extra/missing method, array, async method,
 * non-plain prototype, and own/inherited thenable shapes fail closed without
 * invoking anything.
 */
function admitNativeModuleAbi(value: unknown): unknown | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1
    || keys[0] !== RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD) return null;
  const descriptor = descriptors[RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_OPEN_METHOD];
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
  if (isNativeAsyncFunction(descriptor.value)) return null;
  if (hasThenablePrototypeChain(value)) return null;
  return value;
}

function selectTargetDescriptor(
  platform: string,
  architecture: string,
): RelayV2HostCredentialNativeModuleTargetDescriptor | null {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(TARGET_DESCRIPTORS, target)
    ? TARGET_DESCRIPTORS[target as RelayV2HostCredentialNativeModuleSupportedTarget]
    : null;
}

function takeFailure(
  capability: Exclude<RelayV2HostCredentialNativeModuleCapability, { status: "supported" }>,
): RelayV2HostCredentialNativeModuleSourceError {
  if (capability.status === "unsupported") {
    if (capability.reason === "target_unsupported") return failure("TARGET_UNSUPPORTED");
    if (capability.reason === "interface_version_unsupported") {
      return failure("INTERFACE_VERSION_UNSUPPORTED");
    }
    return failure("NATIVE_ARTIFACT_MISSING");
  }
  return failure("SOURCE_INVALID");
}

/**
 * Default-off, injected-only Host credential native module one-shot
 * source/holder. It is the only owner of the loaded module handle until a
 * one-shot take transfers that ownership; it never reads a path, HOME,
 * environment, argv, JSON, network, or process state, never probes the
 * runtime to mint qualification, never selects an alternate candidate or
 * fallback, and never opens the cell, mutates a credential, or constructs a
 * Vault/authority/composition. Loading happens at most once per source and
 * is memoized; every failure is stable, redacted, and fail closed.
 *
 * This foundation deliberately does not know where a real native module would
 * come from: the frozen contract revision freezes no artifact descriptor,
 * digest, or layout, so a real artifact path requires a NEW contract revision
 * freezing build/stage/pack identity. Nothing here is wired, and nothing
 * produces a qualification, readiness, capability, or productionWired claim.
 */
export function createRelayV2HostCredentialNativeModuleSource(
  target: unknown,
  loadArtifact: RelayV2HostCredentialNativeModuleLoader,
): RelayV2HostCredentialNativeModuleSource {
  const capturedTarget = snapshotTarget(target);
  const capturedLoadArtifact = typeof loadArtifact === "function" ? loadArtifact : null;
  let selection: Selection | undefined;
  let selectionInProgress = false;
  let lifecycle: "active" | "delivered" | "closed" = "active";

  const select = (): Selection => {
    if (selection !== undefined) return selection;
    if (selectionInProgress) {
      // Re-entrant probe while the injected loader is in flight: fail closed
      // without memoizing and without ever calling the loader a second time.
      return Object.freeze({ capability: invalidCapability() });
    }
    const settle = (
      capability: RelayV2HostCredentialNativeModuleCapability,
      binding?: unknown,
    ): Selection => {
      selection = binding === undefined
        ? Object.freeze({ capability })
        : Object.freeze({ capability, binding });
      return selection;
    };
    if (capturedTarget === null || capturedLoadArtifact === null) {
      return settle(invalidCapability());
    }
    const descriptor = selectTargetDescriptor(
      capturedTarget.platform,
      capturedTarget.architecture,
    );
    if (descriptor === null) return settle(unsupportedCapability("target_unsupported"));
    if (!Number.isSafeInteger(capturedTarget.napiVersion)
      || capturedTarget.napiVersion < RELAY_V2_HOST_CREDENTIAL_NATIVE_MODULE_MINIMUM_NAPI_VERSION) {
      return settle(unsupportedCapability("interface_version_unsupported"));
    }
    selectionInProgress = true;
    let loaded: RelayV2HostCredentialNativeModuleLoad | null;
    try {
      loaded = decodeNativeModuleLoad(capturedLoadArtifact(descriptor));
    } catch {
      loaded = null;
    } finally {
      selectionInProgress = false;
    }
    // A re-entrant close() inside the injected loader settles before any
    // store: the returned binding is dropped and the source memoizes invalid,
    // never supported.
    if (lifecycle === "closed") return settle(invalidCapability());
    if (loaded === null) return settle(invalidCapability());
    if (loaded.status === "missing") {
      return settle(unsupportedCapability("native_artifact_missing"));
    }
    if (admitNativeModuleAbi(loaded.binding) === null) return settle(invalidCapability());
    return settle(supportedCapability(descriptor), loaded.binding);
  };

  return Object.freeze({
    capability(): RelayV2HostCredentialNativeModuleCapability {
      if (selection === undefined && lifecycle === "closed") {
        selection = Object.freeze({ capability: invalidCapability() });
        return selection.capability;
      }
      return select().capability;
    },

    takeNativeModule(): unknown {
      if (lifecycle === "delivered") throw failure("SOURCE_CONSUMED");
      if (lifecycle === "closed") throw failure("SOURCE_CLOSED");
      const settled = select();
      // A re-entrant close() inside the injected loader wins over delivery.
      if (lifecycle === "closed") throw failure("SOURCE_CLOSED");
      if (settled.capability.status !== "supported") throw takeFailure(settled.capability);
      const binding = settled.binding;
      // Relinquish the only owned reference before delivery; ownership of the
      // exact module identity moves to the caller and this source can never
      // deliver again.
      selection = Object.freeze({ capability: settled.capability });
      lifecycle = "delivered";
      return binding;
    },

    close(): void {
      if (lifecycle !== "active") return;
      lifecycle = "closed";
      if (selection !== undefined && Object.hasOwn(selection, "binding")) {
        selection = Object.freeze({ capability: selection.capability });
      }
    },
  });
}
