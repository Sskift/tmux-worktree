import { types as nodeUtilTypes } from "node:util";

import {
  RelayV2BrokerCredentialAuthority,
  type RelayV2BrokerCredentialAuthorityGenesis,
} from "./brokerCredentialAuthority.js";
import type { RelayV2BrokerCredentialStateStore } from "./brokerCredentialStateStore.js";
import type { RelayV2BrokerCredentialStateStoreNativeLoader } from "./brokerCredentialStateStoreLoader.js";
import type { RelayV2LiveAuthorizationFencePort } from "./brokerCore.js";
import {
  bindRelayV2ExternalContinuityAuthorityConfig,
  type RelayV2ExternalContinuityAuthorityAttemptProvider,
  type RelayV2ExternalContinuityAuthorityBoundNamespace,
  type RelayV2ExternalContinuityAuthorityConfig,
} from "./externalContinuityAuthorityConfig.js";

const BROKER_CREDENTIAL_NAMESPACE = "broker-credential.v1" as const;
const OPTION_KEYS = [
  "trustedHome",
  "nativeLoader",
  "externalContinuityConfig",
  "externalContinuityAttemptProvider",
  "genesis",
] as const;

export interface RelayV2BrokerCredentialExternalContinuityOpenerOptions {
  /** Caller-owned account-home root; the opener neither derives nor persists it. */
  readonly trustedHome: string;
  readonly nativeLoader: RelayV2BrokerCredentialStateStoreNativeLoader;
  readonly externalContinuityConfig: RelayV2ExternalContinuityAuthorityConfig;
  readonly externalContinuityAttemptProvider:
    RelayV2ExternalContinuityAuthorityAttemptProvider;
  readonly genesis: RelayV2BrokerCredentialAuthorityGenesis;
}

/** Directly injectable into the existing listener-free Broker activation seam. */
export type RelayV2BrokerCredentialExternalContinuityOpener = (
  this: void,
  input: Readonly<{
    liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
  }>,
) => Promise<RelayV2BrokerCredentialAuthority>;

type Snapshot = Readonly<Record<string, unknown>>;

interface OwnedStore {
  readonly store: RelayV2BrokerCredentialStateStore;
  readonly close: Function;
}

function failure(): Error {
  return new Error("Relay v2 broker credential external continuity activation failed");
}

function snapshotExactOwnData(
  value: unknown,
  keys: readonly string[],
): Snapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (nodeUtilTypes.isProxy(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualKeys = Reflect.ownKeys(descriptors);
    if (actualKeys.length !== keys.length
      || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
      return null;
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.get !== undefined
        || descriptor.set !== undefined) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function captureMethod(value: object, name: string): Function | null {
  try {
    if (nodeUtilTypes.isProxy(value)) return null;
    let owner: object | null = value;
    while (owner !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
          ? descriptor.value
          : null;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {}
  return null;
}

function captureStore(value: unknown): OwnedStore | null {
  if (value === null || typeof value !== "object") return null;
  const runExclusive = captureMethod(value, "runExclusive");
  const close = captureMethod(value, "close");
  if (runExclusive === null || close === null) return null;
  return Object.freeze({
    store: value as RelayV2BrokerCredentialStateStore,
    close,
  });
}

function captureStoreFromOpenResult(value: unknown): OwnedStore | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (nodeUtilTypes.isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "store");
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      ? captureStore(descriptor.value)
      : null;
  } catch {
    return null;
  }
}

function captureOpenedStore(value: unknown): OwnedStore | null {
  const snapshot = snapshotExactOwnData(value, ["status", "selfCheck", "store"]);
  if (snapshot === null
    || !Object.isFrozen(value)
    || snapshot.status !== "opened"
    || snapshot.selfCheck !== "passed") return null;
  return captureStore(snapshot.store);
}

async function closeBeforeTransfer(owned: OwnedStore): Promise<never> {
  try {
    await Reflect.apply(owned.close, owned.store, []);
  } catch {}
  throw failure();
}

/**
 * Builds an inert, default-off, one-shot composition. Before the real
 * credential authority is invoked this opener alone owns the opened native
 * store. Invocation is the ownership-transfer cut: every later success or
 * failure is closed by RelayV2BrokerCredentialAuthority's existing barrier.
 */
export function createRelayV2BrokerCredentialExternalContinuityOpener(
  options: RelayV2BrokerCredentialExternalContinuityOpenerOptions,
): RelayV2BrokerCredentialExternalContinuityOpener {
  const captured = snapshotExactOwnData(options, OPTION_KEYS);
  if (captured === null || typeof captured.trustedHome !== "string") throw failure();

  const loader = snapshotExactOwnData(captured.nativeLoader, ["capability", "open"]);
  if (loader === null
    || !Object.isFrozen(captured.nativeLoader)
    || typeof loader.capability !== "function"
    || typeof loader.open !== "function"
    || nodeUtilTypes.isProxy(loader.capability)
    || nodeUtilTypes.isProxy(loader.open)) throw failure();

  const trustedHome = captured.trustedHome;
  const nativeLoader = captured.nativeLoader as RelayV2BrokerCredentialStateStoreNativeLoader;
  const nativeOpen = loader.open;
  const externalContinuityConfig = captured.externalContinuityConfig as
    RelayV2ExternalContinuityAuthorityConfig;
  const externalContinuityAttemptProvider = captured.externalContinuityAttemptProvider as
    RelayV2ExternalContinuityAuthorityAttemptProvider;
  const genesis = captured.genesis as RelayV2BrokerCredentialAuthorityGenesis;
  let available = true;

  const open = Object.freeze(async function relayV2BrokerCredentialExternalContinuityOpen(
    this: unknown,
    input: Readonly<{ liveAuthorizationFence: RelayV2LiveAuthorizationFencePort }>,
  ): Promise<RelayV2BrokerCredentialAuthority> {
    if (this !== undefined || !available) throw failure();
    available = false;

    const openerInput = snapshotExactOwnData(input, ["liveAuthorizationFence"]);
    if (openerInput === null || !Object.isFrozen(input)) throw failure();
    const liveAuthorizationFence = openerInput.liveAuthorizationFence as
      RelayV2LiveAuthorizationFencePort;

    let openResult: unknown;
    try {
      openResult = await Reflect.apply(nativeOpen, nativeLoader, [trustedHome]);
    } catch {
      throw failure();
    }

    const owned = captureOpenedStore(openResult);
    if (owned === null) {
      const malformedOwned = captureStoreFromOpenResult(openResult);
      if (malformedOwned !== null) return await closeBeforeTransfer(malformedOwned);
      throw failure();
    }

    let brokerBinding: RelayV2ExternalContinuityAuthorityBoundNamespace | undefined;
    try {
      const binding = bindRelayV2ExternalContinuityAuthorityConfig(
        externalContinuityConfig,
        externalContinuityAttemptProvider,
      );
      brokerBinding = binding.namespaceBindings.find(
        (candidate) => candidate.namespace === BROKER_CREDENTIAL_NAMESPACE,
      );
    } catch {
      return await closeBeforeTransfer(owned);
    }
    if (brokerBinding === undefined) return await closeBeforeTransfer(owned);
    const continuityAnchor = brokerBinding.continuityAnchorOptions;

    // Calling the real authority is the exact ownership-transfer cut. Do not
    // catch-and-close here: open owns the store on both resolve and rejection.
    return RelayV2BrokerCredentialAuthority.open({
      store: owned.store,
      continuityAnchor,
      genesis,
      liveAuthorizationFence,
    });
  });

  return open as RelayV2BrokerCredentialExternalContinuityOpener;
}
