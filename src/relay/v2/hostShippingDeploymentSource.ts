import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { requestTerminalControl } from "../../terminalControl/client.js";
import { defaultTerminalControlSocketPath } from "../../terminalControl/store.js";
import {
  createRelayV2CanonicalHostRuntimeBundleOwnerV1,
  type RelayV2CanonicalHostRuntimeBundleOwnerV1,
  type RelayV2CanonicalHostRuntimeBundleV1,
} from "./canonicalHostRuntimeBundle.js";
import { relayV2HostCredentialNativeModuleTrustedLoader } from
  "./hostCredentialNativeLoader.js";
import {
  createRelayV2HostCredentialNativeModuleSource,
  type RelayV2HostCredentialNativeModuleSource,
} from "./hostCredentialNativeModuleSource.js";
import {
  readRelayV2HostProductionProfile,
  requireRelayV2HostProductionProfileSnapshot,
  type RelayV2HostProductionProfile,
} from "./hostProductionProfileStore.js";
import {
  RelayV2HostShippingProcessSignalOwner,
  runRelayV2HostShippingProcessLifecycle,
} from "./hostShippingProcessLifecycle.js";
import type { RelayV2HostShippingRootHandle } from "./hostShippingRoot.js";
import {
  captureRelayV2HostSystemTlsTrustCut,
  type RelayV2HostTlsCaTrustCut,
} from "./hostTlsTrustMaterial.js";

declare const relayV2HostTrustedDeploymentActivationBrand: unique symbol;

/**
 * Fieldless process-local ticket. Only this source can issue one, and the
 * canonical Host shipping root consumes its private record exactly once.
 */
export interface RelayV2HostTrustedDeploymentActivation {
  readonly [relayV2HostTrustedDeploymentActivationBrand]: void;
}

export interface RelayV2HostTrustedDeploymentActivationRecord {
  readonly trustedHome: string;
  readonly profileSnapshot: Readonly<RelayV2HostProductionProfile>;
  readonly nativeModuleSource: RelayV2HostCredentialNativeModuleSource;
  readonly runtimeBundle: RelayV2CanonicalHostRuntimeBundleV1;
  readonly terminalControlDaemonSocketPath: string;
  readonly credentialHttpsTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly carrierWssTlsTrustCut: RelayV2HostTlsCaTrustCut;
  readonly startupSignal?: AbortSignal;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostShippingDeploymentSourceErrorCode =
  | "ACTIVATION_INVALID"
  | "ACTIVATION_FAILED"
  | "CLEANUP_FAILED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostShippingDeploymentSourceErrorCode,
string
>> = Object.freeze({
  ACTIVATION_INVALID: "Relay v2 Host trusted deployment activation is invalid",
  ACTIVATION_FAILED: "Relay v2 Host trusted deployment activation failed",
  CLEANUP_FAILED: "Relay v2 Host trusted deployment activation cleanup failed",
});

export class RelayV2HostShippingDeploymentSourceError extends Error {
  constructor(readonly code: RelayV2HostShippingDeploymentSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostShippingDeploymentSourceError";
  }
}

interface ActivationOwner {
  readonly activation: RelayV2HostTrustedDeploymentActivation;
  closeAndDrain(): Promise<void>;
}

const activationRecords =
  new WeakMap<object, RelayV2HostTrustedDeploymentActivationRecord>();

function failure(
  code: RelayV2HostShippingDeploymentSourceErrorCode,
): RelayV2HostShippingDeploymentSourceError {
  return new RelayV2HostShippingDeploymentSourceError(code);
}

function requireStartupOpen(signal?: AbortSignal): void {
  if (signal?.aborted) throw failure("ACTIVATION_FAILED");
}

function exactRegularPath(value: string, label: "Node executable" | "CLI entrypoint"): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(value);
    if (!statSync(canonical).isFile()) throw new TypeError(label);
  } catch {
    throw failure("ACTIVATION_FAILED");
  }
  if (canonical.length === 0 || canonical.includes("\0")) {
    throw failure("ACTIVATION_FAILED");
  }
  return canonical;
}

function currentCliTarget(): Readonly<{ executable: string; entrypoint: string }> {
  const executable = exactRegularPath(process.execPath, "Node executable");
  const rawEntrypoint = process.argv[1];
  if (typeof rawEntrypoint !== "string" || rawEntrypoint.length === 0) {
    throw failure("ACTIVATION_FAILED");
  }
  const entrypoint = exactRegularPath(rawEntrypoint, "CLI entrypoint");
  if (basename(entrypoint) !== "cli.cjs" && basename(entrypoint) !== "tw-cli.cjs") {
    throw failure("ACTIVATION_FAILED");
  }
  return Object.freeze({ executable, entrypoint });
}

async function closeOwned(
  runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null,
  nativeModuleSource: RelayV2HostCredentialNativeModuleSource | null,
): Promise<boolean> {
  let failed = false;
  if (runtimeOwner !== null) {
    try {
      await runtimeOwner.closeAndDrain();
    } catch {
      failed = true;
    }
  }
  if (nativeModuleSource !== null) {
    try {
      nativeModuleSource.close();
    } catch {
      failed = true;
    }
  }
  return failed;
}

async function createActivationOwner(signal?: AbortSignal): Promise<ActivationOwner> {
  let nativeModuleSource: RelayV2HostCredentialNativeModuleSource | null = null;
  let runtimeOwner: RelayV2CanonicalHostRuntimeBundleOwnerV1 | null = null;
  try {
    requireStartupOpen(signal);
    const trustedHome = realpathSync.native(homedir());
    const profileSnapshot = requireRelayV2HostProductionProfileSnapshot(
      readRelayV2HostProductionProfile({ trustedHome }),
    );
    requireStartupOpen(signal);

    nativeModuleSource = createRelayV2HostCredentialNativeModuleSource({
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    }, relayV2HostCredentialNativeModuleTrustedLoader);
    // Drive the revision-7 trusted factory selection before constructing the
    // runtime bundle. This result is only native interface support; it never
    // becomes readiness, durability qualification, or advertised capability.
    if (nativeModuleSource.capability().status !== "supported") {
      throw failure("ACTIVATION_FAILED");
    }
    requireStartupOpen(signal);

    const terminalControlDaemonSocketPath = defaultTerminalControlSocketPath(trustedHome);
    const localCliTarget = currentCliTarget();
    await requestTerminalControl(
      { type: "ping" },
      {
        socketPath: terminalControlDaemonSocketPath,
        autoStart: true,
        autoStartCliTarget: localCliTarget,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    requireStartupOpen(signal);
    runtimeOwner = await createRelayV2CanonicalHostRuntimeBundleOwnerV1({
      localCliTarget,
      terminalControlDaemonSocketPath,
      knownHostsFile: join(trustedHome, ".ssh", "known_hosts"),
      sshExecutable: "/usr/bin/ssh",
    });
    requireStartupOpen(signal);

    // The frozen profile carries no TLS material by contract. Still issue two
    // distinct process-local cuts so HTTPS and WSS cannot share, split, or
    // replace one another's deployment authority; both intentionally select
    // their own Node system-trust lane.
    const credentialHttpsTlsTrustCut = captureRelayV2HostSystemTlsTrustCut();
    const carrierWssTlsTrustCut = captureRelayV2HostSystemTlsTrustCut();
    const ownedRuntime = runtimeOwner;
    const ownedSource = nativeModuleSource;
    let closePromise: Promise<void> | null = null;
    const closeAndDrain = (): Promise<void> => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        if (await closeOwned(ownedRuntime, ownedSource)) {
          throw failure("CLEANUP_FAILED");
        }
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    };

    const activation =
      Object.freeze(Object.create(null)) as RelayV2HostTrustedDeploymentActivation;
    const record = Object.freeze(Object.assign(Object.create(null), {
      trustedHome,
      profileSnapshot,
      nativeModuleSource: ownedSource,
      runtimeBundle: ownedRuntime.bundle,
      terminalControlDaemonSocketPath,
      credentialHttpsTlsTrustCut,
      carrierWssTlsTrustCut,
      ...(signal === undefined ? {} : { startupSignal: signal }),
      closeAndDrain,
    })) as RelayV2HostTrustedDeploymentActivationRecord;
    activationRecords.set(activation as object, record);
    return Object.freeze({ activation, closeAndDrain });
  } catch {
    const cleanupFailed = await closeOwned(runtimeOwner, nativeModuleSource);
    throw failure(cleanupFailed ? "CLEANUP_FAILED" : "ACTIVATION_FAILED");
  }
}

/**
 * Canonical root-only one-shot consumer. A copied, forged, replayed, or
 * already-consumed ticket cannot expose any deployment authority.
 */
export function takeRelayV2HostTrustedDeploymentActivation(
  value: unknown,
): RelayV2HostTrustedDeploymentActivationRecord {
  if (value === null || typeof value !== "object") throw failure("ACTIVATION_INVALID");
  const record = activationRecords.get(value as object);
  if (record === undefined) throw failure("ACTIVATION_INVALID");
  activationRecords.delete(value as object);
  return record;
}

/**
 * The sole default-off Host trusted deployment activation/source. It accepts
 * no caller authority input: the exact existing profile, revision-7 trusted
 * native source, canonical runtime bundle, and the two independent TLS trust
 * cuts are frozen into one opaque one-shot ticket before the shipping root is
 * called. Any failure drains in reverse order and never selects Relay v1.
 */
export async function startRelayV2HostShippingFromTrustedDeployment(
): Promise<RelayV2HostShippingRootHandle> {
  if (arguments.length !== 0) throw failure("ACTIVATION_INVALID");
  return openRelayV2HostShippingFromTrustedDeployment();
}

async function openRelayV2HostShippingFromTrustedDeployment(
  signal?: AbortSignal,
): Promise<RelayV2HostShippingRootHandle> {
  const owner = await createActivationOwner(signal);
  try {
    requireStartupOpen(signal);
    const root = await import("./hostShippingRoot.js");
    requireStartupOpen(signal);
    return await root.startRelayV2HostShippingRootFromTrustedDeployment(
      owner.activation,
    );
  } catch {
    try {
      await owner.closeAndDrain();
    } catch {
      throw failure("CLEANUP_FAILED");
    }
    throw failure("ACTIVATION_FAILED");
  }
}

/**
 * The process entry for the explicit v2 Host lane. Its signal owner is
 * installed before trusted activation and threads one fence through startup.
 * The trusted source opens exactly one shipping root, then the connector
 * lifecycle retains and drives that same handle until signal, failure, or
 * permanent supersession.
 */
export async function runRelayV2HostShippingFromTrustedDeployment(): Promise<number> {
  if (arguments.length !== 0) throw failure("ACTIVATION_INVALID");
  const processSignals = new RelayV2HostShippingProcessSignalOwner();
  try {
    try {
      const handle = await openRelayV2HostShippingFromTrustedDeployment(
        processSignals.signal,
      );
      const result = await runRelayV2HostShippingProcessLifecycle(handle, {
        signal: processSignals.signal,
      });
      return result.exitCode;
    } catch (error) {
      if (processSignals.signal.aborted
        && error instanceof RelayV2HostShippingDeploymentSourceError
        && error.code === "ACTIVATION_FAILED") {
        return 0;
      }
      throw error;
    }
  } finally {
    processSignals.close();
  }
}
