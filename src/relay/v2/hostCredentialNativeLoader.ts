import { createRequire as createNodeRequire } from "node:module";
import { types as nodeTypes } from "node:util";

import {
  getRelayV2HostCredentialNativeTargetDescriptor,
} from "./hostCredentialNativeTarget.js";
import type {
  RelayV2HostCredentialNativeModuleLoad,
  RelayV2HostCredentialNativeModuleLoader,
} from "./hostCredentialNativeModuleSource.js";

const DESCRIPTOR_KEYS = Object.freeze([
  "target",
  "platform",
  "architecture",
  "cargoTargetTriple",
] as const);

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
