import { types as nodeUtilTypes } from "node:util";

import {
  createRelayV2HostCredentialNativeModuleSource,
  type RelayV2HostCredentialNativeModuleCapability,
  type RelayV2HostCredentialNativeModuleLoader,
  type RelayV2HostCredentialNativeModuleTarget,
} from "./hostCredentialNativeModuleSource.js";
import {
  openRelayV2HostNativeCredentialPrivilegedIntakeBridge,
} from "./hostNativeCredentialPrivilegedIntakeBridge.js";
import type {
  RelayV2HostPrivilegedProductionIntakeComposition,
} from "./hostPrivilegedProductionIntakeComposition.js";
import {
  readRelayV2HostProductionProfile,
  type RelayV2HostProductionProfile,
} from "./hostProductionProfileStore.js";
import {
  RelayV2HostStateStore,
  relayV2HostStatePaths,
} from "./hostState.js";
import {
  RelayV2MaterializedStateFoundation,
  type RelayV2ResourceDiscovery,
} from "./resourceState.js";
import {
  RelayV2MaterializedReconcileLifecycleOwner,
  RELAY_V2_MATERIALIZED_RECONCILE_LIFECYCLE_MAX_SCAN_INTERVAL_MS,
} from "./materializedReconcileLifecycleOwner.js";
import { createRelayV2HostRuntimeWelcomeSerializer } from "./hostWelcomeSerializer.js";
import type { RelayV2HostBootstrapSecretByteSource } from "./hostBootstrapSecretSource.js";
import type {
  RelayV2HostManagedConnectorInspection,
  RelayV2HostManagedConnectorStartInput,
  RelayV2HostManagedConnectorStopInput,
} from "./hostRuntimeComposition.js";
import type {
  RelayV2HostConnectorControllerStartResult,
  RelayV2HostConnectorControllerStopResult,
} from "./hostConnectorController.js";
import type { RelayV2RemoteExactCompoundChannelFactoryV1 } from "./remoteExactTerminalControlCompoundV1.js";
import type { RelayV2HostWssTransportLifecycleFactoryOptions } from "./hostWssTransportLifecycle.js";
import type { RelayV2CanonicalCreateTargetExecutionPairV1 } from "./canonicalCreateTargetAdmissionAdapter.js";

/**
 * Explicit, default-off Relay v2 Host shipping root.
 *
 * One root owns the whole explicit-v2 chain in the existing owners' order:
 * the canonical reference-only profile store (relayUrl, issuer, hostId and
 * credential references come only from the runtime profile), the
 * injected-only native credential module source/holder, the existing native
 * privileged intake bridge and atomic cell wrapper, the privileged
 * production intake (Vault, credential authority, HTTPS coordinator), the
 * recovered H0 HostState, the started materialized reconcile lifecycle
 * owner (its startup scan is the first authoritative reconcile and its
 * timer is the only scan timer), the snapshot spool, the production
 * welcome serializer, and the canonical H0-H3 production
 * composition (command plane, exact-observation terminal byte plane,
 * managed connector and credential-exact WSS lifecycle) with the
 * reauthentication lifecycle owner bound inside it to the real
 * authority/coordinator and the exact managed connector cut.
 *
 * The root creates no credential, secret source, native loader, artifact,
 * discovery backend, listener, process, retry timer, readiness, or
 * capability advertisement of its own, and it never falls back to Relay
 * v1: any profile, deployment-input, native-source, recovery, or intake
 * failure fails closed before any socket is constructed. The native module
 * loader, the create-target execution pair, and the runtime lanes are
 * trusted deployment injections; without them the explicit v2 selection
 * fails closed, which is exactly what the CLI path does.
 */
export interface RelayV2HostShippingReauthenticationOptions {
  readonly idFactory?: () => string;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
}

export interface RelayV2HostShippingWssTransport {
  readonly webSocketConstructor: NonNullable<
    RelayV2HostWssTransportLifecycleFactoryOptions["webSocketConstructor"]
  >;
  readonly scheduleCloseDrain?: NonNullable<
    RelayV2HostWssTransportLifecycleFactoryOptions["scheduleCloseDrain"]
  >;
}

export interface RelayV2HostShippingDeploymentInputs {
  /** Injected-only trusted deployment channel for the native credential module. */
  readonly nativeModuleTarget: RelayV2HostCredentialNativeModuleTarget;
  readonly nativeModuleLoader: RelayV2HostCredentialNativeModuleLoader;
  /**
   * The single opaque one-shot create target execution pair, issued by the
   * trusted deployment from the canonical query transport owner. The root
   * only captures the value and hands it to the bridge/intake/canonical
   * owner; it never decomposes, inspects, or validates it.
   */
  readonly createTargetExecutionPair: RelayV2CanonicalCreateTargetExecutionPairV1;
  /** An already-owned privileged channel (0600 file/stdin opened by the caller). */
  readonly bootstrapSecretByteSource?: RelayV2HostBootstrapSecretByteSource;
  /** Deterministic reauthentication scheduling seam; production omits it. */
  readonly reauthentication?: RelayV2HostShippingReauthenticationOptions;
  /** Socket factory seam for tests/deployment; production omission selects `ws`. */
  readonly wssTransport?: RelayV2HostShippingWssTransport;
}

export interface RelayV2HostShippingRuntimeLanes {
  /** Production: the canonical tw-rpc config snapshot foundation's discovery. */
  readonly discovery: RelayV2ResourceDiscovery;
  readonly localProcessTarget: Readonly<{ kind: "local"; targetId: string }>;
  /**
   * Production: the config foundation queryPort's remote exact compound
   * channel factory. The canonical composition requires the terminal-control
   * lane even when no SSH scope is configured.
   */
  readonly remoteCompoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1;
  readonly terminalControlDaemonSocketPath?: string;
  /** Reconcile lifecycle cadence; omission selects the production default. */
  readonly scanIntervalMs?: number;
}

export interface RelayV2HostShippingRootOptions {
  /** Test isolation only; production omission selects the canonical account home. */
  readonly trustedHome?: string;
  readonly deployment: RelayV2HostShippingDeploymentInputs;
  readonly runtime: RelayV2HostShippingRuntimeLanes;
}

export interface RelayV2HostShippingRootHandle {
  inspect(): RelayV2HostManagedConnectorInspection;
  start(
    input: Readonly<RelayV2HostManagedConnectorStartInput>,
  ): Promise<RelayV2HostConnectorControllerStartResult>;
  stopAndDrain(
    input: Readonly<RelayV2HostManagedConnectorStopInput>,
  ): Promise<RelayV2HostConnectorControllerStopResult>;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostShippingRootErrorCode =
  | "INPUTS_INVALID"
  | "INPUTS_UNAVAILABLE"
  | "NATIVE_MODULE_INVALID"
  | "NATIVE_ARTIFACT_MISSING"
  | "NATIVE_TARGET_UNSUPPORTED"
  | "NATIVE_INTERFACE_UNSUPPORTED"
  | "RECONCILE_FAILED"
  | "COMPOSITION_CLOSED"
  | "CLOSE_FAILED";

const ERROR_MESSAGES: Readonly<Record<RelayV2HostShippingRootErrorCode, string>> = Object.freeze({
  INPUTS_INVALID: "Relay v2 Host shipping root inputs are invalid",
  INPUTS_UNAVAILABLE:
    "Relay v2 Host shipping root deployment inputs are unavailable; "
    + "the explicit v2 selection never falls back to Relay v1",
  NATIVE_MODULE_INVALID: "Relay v2 Host credential native module is invalid",
  NATIVE_ARTIFACT_MISSING: "Relay v2 Host credential native module artifact is missing",
  NATIVE_TARGET_UNSUPPORTED: "Relay v2 Host credential native module target is unsupported",
  NATIVE_INTERFACE_UNSUPPORTED:
    "Relay v2 Host credential native module interface version is unsupported",
  RECONCILE_FAILED: "Relay v2 Host materialized startup reconcile failed",
  COMPOSITION_CLOSED: "Relay v2 Host shipping root is closed",
  CLOSE_FAILED: "Relay v2 Host shipping root close failed",
});

export class RelayV2HostShippingRootError extends Error {
  constructor(readonly code: RelayV2HostShippingRootErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostShippingRootError";
  }
}

function failure(code: RelayV2HostShippingRootErrorCode): RelayV2HostShippingRootError {
  return new RelayV2HostShippingRootError(code);
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function isAsyncFunction(value: unknown): boolean {
  try {
    return typeof value === "function"
      && (rejectedProxy(value) || nodeUtilTypes.isAsyncFunction(value));
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

interface CapturedOptions {
  readonly trustedHome: string | undefined;
  readonly nativeModuleTarget: RelayV2HostCredentialNativeModuleTarget;
  readonly nativeModuleLoader: RelayV2HostCredentialNativeModuleLoader;
  readonly createTargetExecutionPair: RelayV2CanonicalCreateTargetExecutionPairV1;
  readonly bootstrapSecretByteSource: RelayV2HostBootstrapSecretByteSource | undefined;
  readonly reauthentication: RelayV2HostShippingReauthenticationOptions | undefined;
  readonly wssTransport: RelayV2HostShippingWssTransport | undefined;
  readonly discovery: RelayV2ResourceDiscovery;
  readonly localProcessTarget: Readonly<{ kind: "local"; targetId: string }>;
  readonly remoteCompoundChannels: RelayV2RemoteExactCompoundChannelFactoryV1;
  readonly terminalControlDaemonSocketPath: string | undefined;
  readonly scanIntervalMs: number;
}

/** Production reconcile cadence; the lifecycle owner owns the only timer. */
const RELAY_V2_HOST_SHIPPING_SCAN_INTERVAL_MS = 30_000;

function captureObjectField(value: unknown): boolean {
  return value !== null && typeof value === "object" && !rejectedProxy(value);
}

function captureOptions(value: unknown): CapturedOptions {
  const record = snapshotExactDataRecord(value, ["deployment", "runtime"], ["trustedHome"]);
  if (record === null) throw failure("INPUTS_UNAVAILABLE");
  if (record.trustedHome !== undefined
    && (typeof record.trustedHome !== "string" || record.trustedHome.length === 0)) {
    throw failure("INPUTS_INVALID");
  }
  const deployment = snapshotExactDataRecord(record.deployment, [
    "nativeModuleTarget",
    "nativeModuleLoader",
    "createTargetExecutionPair",
  ], ["bootstrapSecretByteSource", "reauthentication", "wssTransport"]);
  if (deployment === null
    || deployment.nativeModuleTarget === undefined
    || deployment.nativeModuleLoader === undefined
    || deployment.createTargetExecutionPair === undefined) throw failure("INPUTS_UNAVAILABLE");
  if (isAsyncFunction(deployment.nativeModuleLoader)
    || typeof deployment.nativeModuleLoader !== "function") throw failure("INPUTS_INVALID");
  const target = snapshotExactDataRecord(deployment.nativeModuleTarget, [
    "platform",
    "architecture",
    "napiVersion",
  ]);
  if (target === null
    || typeof target.platform !== "string"
    || typeof target.architecture !== "string"
    || !Number.isSafeInteger(target.napiVersion)) throw failure("INPUTS_INVALID");
  for (const optional of ["bootstrapSecretByteSource", "reauthentication", "wssTransport"] as const) {
    const field = deployment[optional];
    if (field !== undefined && !captureObjectField(field)) throw failure("INPUTS_INVALID");
  }
  const runtime = snapshotExactDataRecord(record.runtime, [
    "discovery",
    "localProcessTarget",
    "remoteCompoundChannels",
  ], ["terminalControlDaemonSocketPath", "scanIntervalMs"]);
  if (runtime === null
    || runtime.discovery === undefined
    || runtime.localProcessTarget === undefined
    || runtime.remoteCompoundChannels === undefined) throw failure("INPUTS_UNAVAILABLE");
  if (!captureObjectField(runtime.discovery)) throw failure("INPUTS_INVALID");
  const localProcessTarget = snapshotExactDataRecord(runtime.localProcessTarget, [
    "kind",
    "targetId",
  ]);
  if (localProcessTarget === null
    || localProcessTarget.kind !== "local"
    || typeof localProcessTarget.targetId !== "string"
    || localProcessTarget.targetId.length === 0) throw failure("INPUTS_INVALID");
  if (!captureObjectField(runtime.remoteCompoundChannels)) throw failure("INPUTS_INVALID");
  if (runtime.terminalControlDaemonSocketPath !== undefined
    && (typeof runtime.terminalControlDaemonSocketPath !== "string"
      || runtime.terminalControlDaemonSocketPath.length === 0)) throw failure("INPUTS_INVALID");
  if (runtime.scanIntervalMs !== undefined
    && (!Number.isSafeInteger(runtime.scanIntervalMs)
      || (runtime.scanIntervalMs as number) <= 0
      || (runtime.scanIntervalMs as number)
        > RELAY_V2_MATERIALIZED_RECONCILE_LIFECYCLE_MAX_SCAN_INTERVAL_MS)) {
    throw failure("INPUTS_INVALID");
  }
  return Object.freeze({
    trustedHome: record.trustedHome as string | undefined,
    nativeModuleTarget: Object.freeze({
      platform: target.platform,
      architecture: target.architecture,
      napiVersion: target.napiVersion,
    }) as RelayV2HostCredentialNativeModuleTarget,
    nativeModuleLoader: deployment.nativeModuleLoader as RelayV2HostCredentialNativeModuleLoader,
    createTargetExecutionPair: deployment.createTargetExecutionPair as
      RelayV2CanonicalCreateTargetExecutionPairV1,
    bootstrapSecretByteSource: deployment.bootstrapSecretByteSource as
      | RelayV2HostBootstrapSecretByteSource
      | undefined,
    reauthentication: deployment.reauthentication as
      | RelayV2HostShippingReauthenticationOptions
      | undefined,
    wssTransport: deployment.wssTransport as RelayV2HostShippingWssTransport | undefined,
    discovery: runtime.discovery as RelayV2ResourceDiscovery,
    localProcessTarget: Object.freeze({
      kind: "local" as const,
      targetId: localProcessTarget.targetId as string,
    }),
    remoteCompoundChannels: runtime.remoteCompoundChannels as
      RelayV2RemoteExactCompoundChannelFactoryV1,
    terminalControlDaemonSocketPath: runtime.terminalControlDaemonSocketPath as string | undefined,
    scanIntervalMs: (runtime.scanIntervalMs as number | undefined)
      ?? RELAY_V2_HOST_SHIPPING_SCAN_INTERVAL_MS,
  });
}

function readProfile(trustedHome: string | undefined): Readonly<RelayV2HostProductionProfile> {
  return trustedHome === undefined
    ? readRelayV2HostProductionProfile()
    : readRelayV2HostProductionProfile({ trustedHome });
}

function nativeModuleFailure(
  capability: Exclude<RelayV2HostCredentialNativeModuleCapability, { status: "supported" }>,
): RelayV2HostShippingRootError {
  if (capability.status === "unsupported") {
    if (capability.reason === "target_unsupported") return failure("NATIVE_TARGET_UNSUPPORTED");
    if (capability.reason === "interface_version_unsupported") {
      return failure("NATIVE_INTERFACE_UNSUPPORTED");
    }
    return failure("NATIVE_ARTIFACT_MISSING");
  }
  return failure("NATIVE_MODULE_INVALID");
}

function issueHandle(
  intake: RelayV2HostPrivilegedProductionIntakeComposition,
  lifecycleOwner: RelayV2MaterializedReconcileLifecycleOwner,
  closeSource: () => void,
): RelayV2HostShippingRootHandle {
  let lifecycle: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | null = null;
  const guard = (): void => {
    if (lifecycle !== "open") throw failure("COMPOSITION_CLOSED");
  };
  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    // Fence new start/reauthentication before any drain begins.
    lifecycle = "closing";
    closePromise = (async () => {
      let failed = false;
      // The reconcile lifecycle mutates materialized state through the
      // foundation: fence its triggers and drain its in-flight scan before
      // the intake may close the canonical composition, spool, and HostState.
      try {
        await lifecycleOwner.close();
      } catch {
        failed = true;
      }
      try {
        await intake.closeAndDrain();
      } catch {
        failed = true;
      }
      closeSource();
      lifecycle = "closed";
      if (failed) throw failure("CLOSE_FAILED");
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  const handle = Object.create(null) as RelayV2HostShippingRootHandle;
  Object.defineProperties(handle, {
    inspect: {
      enumerable: true,
      value: (): RelayV2HostManagedConnectorInspection => {
        guard();
        return intake.inspect();
      },
    },
    start: {
      enumerable: true,
      value: (input: Readonly<RelayV2HostManagedConnectorStartInput>) => {
        guard();
        return intake.start(input);
      },
    },
    stopAndDrain: {
      enumerable: true,
      value: (input: Readonly<RelayV2HostManagedConnectorStopInput>) => {
        guard();
        return intake.stopAndDrain(input);
      },
    },
    closeAndDrain: { enumerable: true, value: closeAndDrain },
  });
  return Object.freeze(handle);
}

/**
 * Start the shipping root from the canonical runtime profile and injected
 * deployment inputs. Validation, the native-source capability probe, H0
 * recovery, materialized reconcile, and the privileged intake all complete
 * before any socket can be constructed; a failure at any stage rolls back
 * in reverse order and never falls back to Relay v1.
 */
export async function startRelayV2HostShippingRoot(
  options: unknown,
): Promise<RelayV2HostShippingRootHandle> {
  const captured = captureOptions(options);
  const profile = readProfile(captured.trustedHome);
  const source = createRelayV2HostCredentialNativeModuleSource(
    captured.nativeModuleTarget,
    captured.nativeModuleLoader,
  );
  const closeSource = (): void => {
    try {
      source.close();
    } catch {
      // The bounded fail-closed recycle never throws; keep rollback moving.
    }
  };

  let store: RelayV2HostStateStore | null = null;
  let spool: { close(): Promise<void> } | null = null;
  let lifecycleOwner: RelayV2MaterializedReconcileLifecycleOwner | null = null;
  let intake: RelayV2HostPrivilegedProductionIntakeComposition;
  try {
    // Absent/unsupported native sources fail here, before the one-shot take
    // is consumed and long before any socket could exist.
    const capability = source.capability();
    if (capability.status !== "supported") throw nativeModuleFailure(capability);

    store = await RelayV2HostStateStore.open({
      paths: relayV2HostStatePaths(captured.trustedHome),
    });
    const foundation = new RelayV2MaterializedStateFoundation({
      hostId: profile.hostId,
      discovery: captured.discovery,
      store,
      readinessSink: Object.freeze({ apply: () => true }),
    });
    // The root is the only constructor and starter of the existing reconcile
    // lifecycle owner; its startup scan is the first authoritative reconcile
    // and must settle before the spool and the canonical composition open.
    lifecycleOwner = new RelayV2MaterializedReconcileLifecycleOwner(Object.freeze({
      reconcilePort: Object.freeze({ reconcile: () => foundation.reconcile() }),
      scanIntervalMs: captured.scanIntervalMs,
    }));
    if (await lifecycleOwner.start() !== "reconciled") throw failure("RECONCILE_FAILED");
    spool = await foundation.openStateSnapshotSpool({
      hostId: profile.hostId,
      ownerInstanceId: store.hostInstanceId,
      ...(captured.trustedHome === undefined ? {} : { home: captured.trustedHome }),
    });
    const welcome = createRelayV2HostRuntimeWelcomeSerializer({ hostId: profile.hostId });

    intake = await openRelayV2HostNativeCredentialPrivilegedIntakeBridge({
      takeNativeModule: source.takeNativeModule,
      ...(captured.trustedHome === undefined ? {} : { trustedHome: captured.trustedHome }),
      ...(captured.bootstrapSecretByteSource === undefined
        ? {}
        : { bootstrapSecretByteSource: captured.bootstrapSecretByteSource }),
      ...(captured.reauthentication === undefined
        ? {}
        : { reauthentication: captured.reauthentication }),
      ...(captured.wssTransport === undefined ? {} : { wssTransport: captured.wssTransport }),
      canonical: Object.freeze({
        hostState: store,
        recoveredH2Spool: spool,
        welcome,
        createTargetExecutionPair: captured.createTargetExecutionPair,
        localProcessTarget: captured.localProcessTarget,
        terminalControl: Object.freeze({
          remoteCompoundChannels: captured.remoteCompoundChannels,
          ...(captured.terminalControlDaemonSocketPath === undefined
            ? {}
            : { daemonSocketPath: captured.terminalControlDaemonSocketPath }),
        }),
      }),
    });
  } catch (error) {
    // The bridge and intake drain the claimed cell and close the spool and
    // HostState on every failure after they claim them, and both owners make
    // those closes idempotent, so repeating them here is safe and also covers
    // failures before the bridge was reached. Roll back in reverse order:
    // reconcile lifecycle first, then spool, HostState, and the native source.
    let closeFailed = false;
    if (lifecycleOwner !== null) {
      try {
        await lifecycleOwner.close();
      } catch {
        closeFailed = true;
      }
    }
    if (spool !== null) {
      try {
        await spool.close();
      } catch {
        closeFailed = true;
      }
    }
    if (store !== null) {
      try {
        await store.close();
      } catch {
        closeFailed = true;
      }
    }
    closeSource();
    if (closeFailed) throw failure("CLOSE_FAILED");
    throw error;
  }

  return issueHandle(intake, lifecycleOwner!, closeSource);
}

/**
 * CLI-facing entry for `relay-host --profile v2`. The CLI process has no
 * trusted channel for the deployment injections above (native module
 * source, create-target execution, runtime lanes), so the explicit v2
 * selection fails closed here — before reading the profile, opening the
 * state store, or constructing any socket — and never falls back to v1.
 */
export function runRelayV2HostShippingFromCli(): never {
  throw failure("INPUTS_UNAVAILABLE");
}
