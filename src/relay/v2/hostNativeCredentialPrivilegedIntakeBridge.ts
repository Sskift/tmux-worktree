import { types as nodeTypes } from "node:util";

import {
  openRelayV2HostCredentialAtomicFileCellNative,
  RelayV2HostCredentialAtomicFileCellNativeError,
} from "./hostCredentialAtomicFileCellNative.js";
import {
  openRelayV2HostPrivilegedProductionIntakeComposition,
  type RelayV2HostPrivilegedProductionCanonicalOptions,
  type RelayV2HostPrivilegedProductionIntakeComposition,
} from "./hostPrivilegedProductionIntakeComposition.js";
import type { RelayV2HostBootstrapSecretByteSource } from "./hostBootstrapSecretSource.js";

export interface RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions {
  /**
   * Caller-owned, exact-own-data, synchronous one-shot source of the pre-bound
   * raw native module. This bridge takes it exactly once and never retries.
   */
  readonly takeNativeModule: () => unknown;
  /** Test isolation only; production omission selects the canonical account home. */
  readonly trustedHome?: string;
  /** An already-owned privileged channel. No source is selected by this owner. */
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
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

function isAsyncFunction(value: unknown): boolean {
  try {
    return rejectedProxy(value) || nodeTypes.isAsyncFunction(value);
  } catch {
    return true;
  }
}

function isAsynchronousResult(value: unknown): boolean {
  try {
    if (nodeTypes.isPromise(value)) return true;
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return false;
    }
    let current: object | null = value as object;
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
 * Default-off, injected-only one-shot ownership bridge from a caller-owned
 * native module source to the existing Host credential cell wrapper and the
 * existing privileged production intake composition. It never reads a path,
 * HOME, environment, process, or network; never selects an artifact, target,
 * loader, or secret source; never opens the H4a path cell; never constructs a
 * second Vault/authority/coordinator/canonical owner; and never starts a CLI,
 * connector, capability advertisement, retry, or fallback. The bridge itself
 * owns the one-shot claim: the exact source callable identity is claimed
 * synchronously and permanently before any user code runs, so a duplicate or
 * concurrent open with the same source fails closed before touching anything.
 * Source, module,
 * cell, and raw handles never appear in the returned facade, errors, or logs.
 */
export async function openRelayV2HostNativeCredentialPrivilegedIntakeBridge(
  options: RelayV2HostNativeCredentialPrivilegedIntakeBridgeOptions,
): Promise<RelayV2HostPrivilegedProductionIntakeComposition> {
  const captured = snapshotExactDataRecord(
    options,
    ["takeNativeModule", "canonical"],
    ["trustedHome", "bootstrapSecretByteSource"],
  );
  const take = captured?.takeNativeModule;
  if (captured === null
    || typeof take !== "function"
    || isAsyncFunction(take)) throw failure("SOURCE_INVALID");
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
    credentialCell: cell,
    bootstrapSecretByteSource: captured.bootstrapSecretByteSource as
      | RelayV2HostBootstrapSecretByteSource
      | undefined,
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
