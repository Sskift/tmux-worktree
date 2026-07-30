import { types as nodeTypes } from "node:util";

import {
  openRelayV2HostCredentialAtomicFileCellNative,
  RelayV2HostCredentialAtomicFileCellNativeError,
} from "./hostCredentialAtomicFileCellNative.js";
import {
  openRelayV2HostPrivilegedProductionIntakeComposition,
  type RelayV2HostPrivilegedProductionCanonicalOptions,
  type RelayV2HostPrivilegedProductionCredentialHttpsTransport,
  type RelayV2HostPrivilegedProductionIntakeComposition,
  type RelayV2HostPrivilegedProductionReauthenticationOptions,
  type RelayV2HostPrivilegedProductionWssTransport,
} from "./hostPrivilegedProductionIntakeComposition.js";
import type { RelayV2HostBootstrapSecretByteSource } from "./hostBootstrapSecretSource.js";
import type { RelayV2HostProductionProfile } from "./hostProductionProfileStore.js";
import {
  captureRelayV2HostTlsCaTrust,
  type RelayV2HostTlsCaTrust,
} from "./hostTlsTrustMaterial.js";
import {
  issueRelayV2HostSelfHostedCapabilityActivationHandoff,
} from "./hostRuntimeComposition.js";

export interface RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions {
  /**
   * Caller-owned, exact-own-data, synchronous one-shot source of the pre-bound
   * raw native module. This bridge takes it exactly once and never retries.
   */
  readonly takeNativeModule: () => unknown;
  /** Test isolation only; production omission selects the canonical account home. */
  readonly trustedHome?: string;
  /** Exact snapshot already frozen by the outer shipping activation. */
  readonly profileSnapshot?: Readonly<RelayV2HostProductionProfile>;
  /** An already-owned privileged channel. No source is selected by this owner. */
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
  /** Exact outer startup signal forwarded unchanged to the intake owner. */
  readonly startupSignal?: AbortSignal;
  /** Deterministic reauthentication overrides forwarded to the intake. */
  readonly reauthentication?: RelayV2HostPrivilegedProductionReauthenticationOptions;
  /** Isolated test seam; the production shipping root never supplies it. */
  readonly credentialHttpsTransport?:
    RelayV2HostPrivilegedProductionCredentialHttpsTransport;
  /** Socket factory seam forwarded to the intake. */
  readonly wssTransport?: RelayV2HostPrivilegedProductionWssTransport;
  /** Independent CA-only extension for the credential issuer HTTPS lane. */
  readonly credentialHttpsTlsTrust?: RelayV2HostTlsCaTrust;
  /** Independent CA-only extension for the carrier WSS lane. */
  readonly carrierWssTlsTrust?: RelayV2HostTlsCaTrust;
  readonly canonical: RelayV2HostPrivilegedProductionCanonicalOptions;
}

export type RelayV2HostNativeCredentialPrivilegedIntakeBridgeErrorCode =
  | "SOURCE_INVALID"
  | "SOURCE_TAKE_FAILED"
  | "CELL_DURABILITY_UNSUPPORTED"
  | "CELL_OPEN_FAILED"
  | "INTAKE_UNAVAILABLE"
  | "SOURCE_CONSUMED"
  | "MODULE_CONSUMED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostNativeCredentialPrivilegedIntakeBridgeErrorCode,
string
>> = Object.freeze({
  SOURCE_INVALID: "Relay v2 Host native credential source is invalid",
  SOURCE_TAKE_FAILED: "Relay v2 Host native credential source take failed",
  CELL_DURABILITY_UNSUPPORTED:
    "Relay v2 Host native credential cell durability is unsupported",
  CELL_OPEN_FAILED: "Relay v2 Host native credential cell open failed",
  INTAKE_UNAVAILABLE: "Relay v2 Host privileged intake is unavailable",
  SOURCE_CONSUMED: "Relay v2 Host native credential source is consumed",
  MODULE_CONSUMED: "Relay v2 Host native credential module is consumed",
});

export class RelayV2HostNativeCredentialPrivilegedIntakeBridgeError extends Error {
  constructor(
    readonly code: RelayV2HostNativeCredentialPrivilegedIntakeBridgeErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostNativeCredentialPrivilegedIntakeBridgeError";
  }
}

function failure(
  code: RelayV2HostNativeCredentialPrivilegedIntakeBridgeErrorCode,
): RelayV2HostNativeCredentialPrivilegedIntakeBridgeError {
  return new RelayV2HostNativeCredentialPrivilegedIntakeBridgeError(code);
}

// This module is the canonical owner of the one-shot source and native-module
// claims. Both registries live only here; the tsup external entries keep the
// intake and the native cell wrapper on their canonical dist owners, and no
// other entry bundles this bridge, so exactly one copy of each WeakSet exists
// per process. The callable claim stops replay of one source; the module claim
// stops two different callables (or two bind() results) that yield the same
// exact nativeModule identity from ever producing two wrapper/cell owners over
// the same raw handle. Neither claim is ever released, on success or failure.
const claimedSourceTakeIdentities = new WeakSet<object>();
const claimedNativeModuleIdentities = new WeakSet<object>();

const NODE_IS_ASYNC_FUNCTION = nodeTypes.isAsyncFunction;
const NODE_IS_PROMISE = nodeTypes.isPromise;
const NODE_IS_PROXY = nodeTypes.isProxy;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return REFLECT_APPLY(NODE_IS_PROXY, undefined, [value]);
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
    || REFLECT_APPLY(ARRAY_IS_ARRAY, undefined, [value])
    || rejectedProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      undefined,
      [value],
    );
    prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, undefined, [value]);
  } catch {
    return null;
  }
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return null;
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, undefined, [descriptors]);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (typeof key !== "string") return null;
    let allowed = false;
    for (let index = 0; index < required.length; index += 1) {
      if (required[index] === key) allowed = true;
    }
    for (let index = 0; index < optional.length; index += 1) {
      if (optional[index] === key) allowed = true;
    }
    if (!allowed) return null;
  }
  const result = REFLECT_APPLY(OBJECT_CREATE, undefined, [null]) as Record<string, unknown>;
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, undefined, [descriptors, key])) return null;
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !REFLECT_APPLY(OBJECT_HAS_OWN, undefined, [descriptor, "value"])) return null;
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  for (let index = 0; index < optional.length; index += 1) {
    const key = optional[index];
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, undefined, [descriptors, key])) continue;
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !REFLECT_APPLY(OBJECT_HAS_OWN, undefined, [descriptor, "value"])) return null;
    if (descriptor.value !== undefined) result[key] = descriptor.value;
  }
  return REFLECT_APPLY(OBJECT_FREEZE, undefined, [result]);
}

function isAsyncFunction(value: unknown): boolean {
  try {
    return rejectedProxy(value)
      || REFLECT_APPLY(NODE_IS_ASYNC_FUNCTION, undefined, [value]);
  } catch {
    return true;
  }
}

function isAsynchronousResult(value: unknown): boolean {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return false;
    }
    if (rejectedProxy(value)) return true;
    if (REFLECT_APPLY(NODE_IS_PROMISE, undefined, [value])) return true;
    let current: object | null = value as object;
    while (current !== null) {
      if (rejectedProxy(current)) return true;
      const descriptor = REFLECT_APPLY(
        OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
        undefined,
        [current, "then"],
      );
      if (descriptor !== undefined) {
        return !REFLECT_APPLY(OBJECT_HAS_OWN, undefined, [descriptor, "value"])
          || typeof descriptor.value === "function";
      }
      current = REFLECT_APPLY(
        OBJECT_GET_PROTOTYPE_OF,
        undefined,
        [current],
      ) as object | null;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Default-off, injected-only one-shot ownership bridge from a caller-owned
 * native module source to the existing Host credential cell wrapper and the
 * existing privileged production intake composition. It never reads a path,
 * HOME, environment, process, or network; never selects an artifact, target,
 * loader, secret source, or network transport; never opens the H4a path cell;
 * never constructs a second Vault/authority/coordinator/canonical owner; and
 * never starts a CLI, connector, capability advertisement, retry, or fallback.
 * The intake may use its isolated injected test transport; production shipping
 * omits that seam and selects HTTPS only inside the existing intake owner.
 * The bridge itself
 * owns the one-shot claim: the exact source callable identity is claimed
 * synchronously and permanently before any user code runs, so a duplicate or
 * concurrent open with the same source fails closed before touching anything.
 * Source, module,
 * cell, and raw handles never appear in the returned facade, errors, or logs.
 */
export async function openRelayV2HostNativeCredentialPrivilegedIntakeBridge(
  options: RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions,
): Promise<RelayV2HostPrivilegedProductionIntakeComposition> {
  return openRelayV2HostNativeCredentialPrivilegedIntakeBridgeInternal(
    options,
    false,
  );
}

/**
 * Explicit self-hosted Darwin arm64 entry. It uses the same native-cell and
 * privileged-intake owners, while independently issuing the one-shot base
 * capability handoff for the exact cell. Production never calls this entry.
 */
export async function openRelayV2HostSelfHostedNativeCredentialPrivilegedIntakeBridge(
  options: RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions,
): Promise<RelayV2HostPrivilegedProductionIntakeComposition> {
  return openRelayV2HostNativeCredentialPrivilegedIntakeBridgeInternal(
    options,
    true,
  );
}

async function openRelayV2HostNativeCredentialPrivilegedIntakeBridgeInternal(
  options: RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions,
  activateSelfHostedBaseCapabilities: boolean,
): Promise<RelayV2HostPrivilegedProductionIntakeComposition> {
  const captured = snapshotExactDataRecord(
    options,
    ["takeNativeModule", "canonical"],
    [
      "trustedHome",
      "profileSnapshot",
      "bootstrapSecretByteSource",
      "startupSignal",
      "reauthentication",
      "credentialHttpsTransport",
      "wssTransport",
      "credentialHttpsTlsTrust",
      "carrierWssTlsTrust",
    ],
  );
  const take = captured?.takeNativeModule;
  if (captured === null
    || typeof take !== "function"
    || isAsyncFunction(take)) throw failure("SOURCE_INVALID");
  let credentialHttpsTlsTrust: RelayV2HostTlsCaTrust | undefined;
  let carrierWssTlsTrust: RelayV2HostTlsCaTrust | undefined;
  try {
    credentialHttpsTlsTrust = captured.credentialHttpsTlsTrust === undefined
      ? undefined
      : captureRelayV2HostTlsCaTrust(captured.credentialHttpsTlsTrust);
    carrierWssTlsTrust = captured.carrierWssTlsTrust === undefined
      ? undefined
      : captureRelayV2HostTlsCaTrust(captured.carrierWssTlsTrust);
  } catch {
    throw failure("SOURCE_INVALID");
  }
  // Synchronous, atomic, permanent claim on the exact callable identity. It is
  // recorded before the source, the native wrapper, or the intake are touched,
  // and is never released: once claimed, success or failure, the source is
  // consumed forever, so the same raw handle can never be taken over by two
  // wrapper/cell owners. Everything up to the first await below runs in one
  // synchronous turn, so a duplicate or concurrent open with the same callable
  // fails closed here before any user code runs.
  const takeIdentity = take as object;
  if (claimedSourceTakeIdentities.has(takeIdentity)) throw failure("SOURCE_CONSUMED");
  claimedSourceTakeIdentities.add(takeIdentity);

  let nativeModule: unknown;
  try {
    nativeModule = Reflect.apply(take as (...args: unknown[]) => unknown, undefined, []);
  } catch {
    throw failure("SOURCE_TAKE_FAILED");
  }
  if (isAsynchronousResult(nativeModule)) throw failure("SOURCE_INVALID");
  if ((typeof nativeModule !== "object" || nativeModule === null)
    && typeof nativeModule !== "function") throw failure("SOURCE_INVALID");
  // Synchronous, atomic, permanent claim on the exact nativeModule identity,
  // recorded after the take result is validated but before the native wrapper
  // is touched, with no await between check and add. Two different callables
  // or two bind() results that yield the same module identity can each run
  // their own take once, but only the first reaches the wrapper; the rest
  // fail closed here before native open, intake, or canonical are touched.
  const moduleIdentity = nativeModule as object;
  if (claimedNativeModuleIdentities.has(moduleIdentity)) {
    throw failure("MODULE_CONSUMED");
  }
  claimedNativeModuleIdentities.add(moduleIdentity);

  let cell;
  try {
    cell = openRelayV2HostCredentialAtomicFileCellNative({ nativeModule });
  } catch (error) {
    if (error instanceof RelayV2HostCredentialAtomicFileCellNativeError
      && error.code === "CELL_DURABILITY_UNSUPPORTED") {
      // Host qualifiedRecords=[] durability refusal means only "v2
      // unavailable"; it is never a missing file and never routes to H4a/v1.
      throw failure("CELL_DURABILITY_UNSUPPORTED");
    }
    throw failure("CELL_OPEN_FAILED");
  }

  const intake = await openRelayV2HostPrivilegedProductionIntakeComposition({
    trustedHome: captured.trustedHome as string | undefined,
    profileSnapshot: captured.profileSnapshot as
      | Readonly<RelayV2HostProductionProfile>
      | undefined,
    credentialCell: cell,
    bootstrapSecretByteSource: captured.bootstrapSecretByteSource as
      | RelayV2HostBootstrapSecretByteSource
      | undefined,
    startupSignal: captured.startupSignal as AbortSignal | undefined,
    reauthentication: captured.reauthentication as
      | RelayV2HostPrivilegedProductionReauthenticationOptions
      | undefined,
    credentialHttpsTransport: captured.credentialHttpsTransport as
      | RelayV2HostPrivilegedProductionCredentialHttpsTransport
      | undefined,
    wssTransport: captured.wssTransport as
      | RelayV2HostPrivilegedProductionWssTransport
      | undefined,
    credentialHttpsTlsTrust,
    carrierWssTlsTrust,
    ...(activateSelfHostedBaseCapabilities
      ? {
          selfHostedCapabilityActivationHandoff:
            issueRelayV2HostSelfHostedCapabilityActivationHandoff(cell),
        }
      : {}),
    canonical: captured.canonical as RelayV2HostPrivilegedProductionCanonicalOptions,
  });
  // A thrown intake error is already stable and redacted, and the intake has
  // drained the captured cell exactly once on every failure after capture.
  if (intake === null) {
    try {
      await cell.closeAndDrain();
    } catch {
      // The bridge still fails closed; the close failure adds no new signal.
    }
    throw failure("INTAKE_UNAVAILABLE");
  }
  return intake;
}
