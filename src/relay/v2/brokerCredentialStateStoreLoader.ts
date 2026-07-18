import { createRequire as createNodeRequire } from "node:module";
import {
  RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  openRelayV2BrokerCredentialStateStoreNativeBinding,
  readRelayV2BrokerCredentialStateStoreNativeCapability,
  type RelayV2BrokerCredentialStateStoreCapability,
  type RelayV2BrokerCredentialStateStoreFailure,
  type RelayV2BrokerCredentialStateStoreOpenResult,
} from "./brokerCredentialStateStore.js";
import {
  selectRelayV2BrokerCredentialStateStoreNativeTargetDescriptor,
  type RelayV2BrokerCredentialStateStoreNativeArtifactDescriptor,
} from "./brokerCredentialStateStoreNativeTarget.js";

export interface RelayV2BrokerCredentialStateStoreNativeTarget {
  readonly platform: string;
  readonly architecture: string;
  readonly napiVersion: number;
}

export type RelayV2BrokerCredentialStateStoreNativeArtifact =
  RelayV2BrokerCredentialStateStoreNativeArtifactDescriptor;

export type RelayV2BrokerCredentialStateStoreNativeArtifactLoad =
  | { readonly status: "loaded"; readonly binding: unknown }
  | { readonly status: "missing" };

/**
 * Test seam. The loader chooses the frozen descriptor; callers
 * cannot supply a module path or add an alternate artifact/fallback candidate.
 */
export type RelayV2BrokerCredentialStateStoreNativeArtifactModuleLoader = (
  artifact: RelayV2BrokerCredentialStateStoreNativeArtifact,
) => RelayV2BrokerCredentialStateStoreNativeArtifactLoad;

export interface RelayV2BrokerCredentialStateStoreNativeLoader {
  /** Artifact/target/interface support only. This is never a readiness result. */
  capability(): RelayV2BrokerCredentialStateStoreCapability;

  /**
   * Opens with the exact caller-owned account-home root and frozen admission
   * limit. opened+selfCheck still requires T1 external continuity before ready.
   */
  open(trustedHome: string): Promise<RelayV2BrokerCredentialStateStoreOpenResult>;
}

function invalidFailure(): RelayV2BrokerCredentialStateStoreFailure {
  return Object.freeze({ code: "NATIVE_INTERFACE_INVALID" });
}

function invalidCapability(): RelayV2BrokerCredentialStateStoreCapability {
  return Object.freeze({ status: "invalid", error: invalidFailure() });
}

function selectArtifact(
  target: RelayV2BrokerCredentialStateStoreNativeTarget,
): RelayV2BrokerCredentialStateStoreNativeArtifact | null {
  return selectRelayV2BrokerCredentialStateStoreNativeTargetDescriptor(
    target.platform,
    target.architecture,
  )?.runtimeArtifact ?? null;
}

function capabilityAsOpenResult(
  capability: Exclude<RelayV2BrokerCredentialStateStoreCapability, { status: "supported" }>,
): RelayV2BrokerCredentialStateStoreOpenResult {
  return capability.status === "unsupported"
    ? Object.freeze({ status: "unsupported", reason: capability.reason })
    : Object.freeze({ status: "invalid", error: capability.error });
}

function snapshotOwnDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Reflect.ownKeys(descriptors);
    if (actualKeys.some((key) => typeof key !== "string")) return null;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of actualKeys as string[]) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function snapshotTarget(
  value: unknown,
): Readonly<RelayV2BrokerCredentialStateStoreNativeTarget> | null {
  const snapshot = snapshotOwnDataRecord(value);
  if (
    snapshot === null
    || !hasExactKeys(snapshot, ["platform", "architecture", "napiVersion"])
    || typeof snapshot.platform !== "string"
    || typeof snapshot.architecture !== "string"
  ) return null;
  return Object.freeze({
    platform: snapshot.platform,
    architecture: snapshot.architecture,
    napiVersion: snapshot.napiVersion as number,
  });
}

function decodeArtifactLoad(
  value: unknown,
): RelayV2BrokerCredentialStateStoreNativeArtifactLoad | null {
  const snapshot = snapshotOwnDataRecord(value);
  if (
    snapshot !== null
    && hasExactKeys(snapshot, ["status"])
    && snapshot.status === "missing"
  ) {
    return Object.freeze({ status: "missing" });
  }
  if (
    snapshot === null
    || !hasExactKeys(snapshot, ["status", "binding"])
    || snapshot.status !== "loaded"
  ) return null;
  return Object.freeze({ status: "loaded", binding: snapshot.binding });
}

export function createRelayV2BrokerCredentialStateStoreNativeLoader(
  target: unknown,
  loadArtifact: RelayV2BrokerCredentialStateStoreNativeArtifactModuleLoader,
): RelayV2BrokerCredentialStateStoreNativeLoader {
  const capturedTarget = snapshotTarget(target);
  let selected:
    | {
        readonly capability: RelayV2BrokerCredentialStateStoreCapability;
        readonly binding?: unknown;
      }
    | undefined;

  const select = (): typeof selected & {} => {
    if (selected !== undefined) return selected;
    if (capturedTarget === null || typeof loadArtifact !== "function") {
      selected = Object.freeze({ capability: invalidCapability() });
      return selected;
    }
    const artifact = selectArtifact(capturedTarget);
    if (artifact === null) {
      selected = Object.freeze({
        capability: Object.freeze({ status: "unsupported", reason: "target_unsupported" }),
      });
      return selected;
    }
    if (!Number.isSafeInteger(capturedTarget.napiVersion) || capturedTarget.napiVersion < 9) {
      selected = Object.freeze({
        capability: Object.freeze({
          status: "unsupported",
          reason: "interface_version_unsupported",
        }),
      });
      return selected;
    }
    try {
      const loaded = decodeArtifactLoad(loadArtifact(artifact));
      if (loaded === null) {
        selected = Object.freeze({ capability: invalidCapability() });
        return selected;
      }
      if (loaded.status === "missing") {
        selected = Object.freeze({
          capability: Object.freeze({
            status: "unsupported",
            reason: "native_artifact_missing",
          }),
        });
        return selected;
      }
      const capability = readRelayV2BrokerCredentialStateStoreNativeCapability(
        loaded.binding,
      );
      selected = capability.status === "supported"
        ? Object.freeze({ capability, binding: loaded.binding })
        : Object.freeze({ capability });
      return selected;
    } catch {
      selected = Object.freeze({ capability: invalidCapability() });
      return selected;
    }
  };

  return Object.freeze({
    capability(): RelayV2BrokerCredentialStateStoreCapability {
      return select().capability;
    },

    async open(trustedHome: string): Promise<RelayV2BrokerCredentialStateStoreOpenResult> {
      const selection = select();
      if (selection.capability.status !== "supported") {
        return capabilityAsOpenResult(selection.capability);
      }
      return openRelayV2BrokerCredentialStateStoreNativeBinding(selection.binding, {
        trustedHome,
        maxStateBytes: RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
      });
    },
  });
}

const nativeRequire = createNodeRequire(import.meta.url);

function isModuleNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && Object.getOwnPropertyDescriptor(error, "code")?.value === "MODULE_NOT_FOUND";
}

/**
 * Fixed-mapping module-runtime adapter seam. Callers may replace resolve/load
 * operations for tests, but cannot provide an artifact specifier or map. The
 * loaded binding remains opaque here and is decoded only by the N0 wrapper.
 */
export function createRelayV2BrokerCredentialStateStoreNativeLoaderWithModuleRuntime(
  target: unknown,
  resolveArtifact: (fixedModuleSpecifier: string) => string,
  loadResolvedArtifact: (resolvedArtifact: string) => unknown,
): RelayV2BrokerCredentialStateStoreNativeLoader {
  const loadMappedNativeArtifact: RelayV2BrokerCredentialStateStoreNativeArtifactModuleLoader =
    (artifact) => {
      let resolved: string;
      try {
        resolved = resolveArtifact(artifact.moduleSpecifier);
      } catch (error) {
        // Resolution happens before evaluation. Only absence of this exact,
        // fixed mapped artifact is optional; every failure after resolution is
        // an invalid native boundary and must not be disguised as missing.
        if (isModuleNotFound(error)) return Object.freeze({ status: "missing" });
        throw error;
      }
      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error("native artifact resolver returned an invalid identity");
      }
      return Object.freeze({ status: "loaded", binding: loadResolvedArtifact(resolved) });
    };
  return createRelayV2BrokerCredentialStateStoreNativeLoader(
    target,
    loadMappedNativeArtifact,
  );
}

export const relayV2BrokerCredentialStateStoreNativeLoader =
  createRelayV2BrokerCredentialStateStoreNativeLoaderWithModuleRuntime(
    Object.freeze({
      platform: process.platform,
      architecture: process.arch,
      napiVersion: Number(process.versions.napi),
    }),
    (fixedModuleSpecifier) => nativeRequire.resolve(fixedModuleSpecifier),
    (resolvedArtifact) => nativeRequire(resolvedArtifact),
  );
