import { types as nodeUtilTypes } from "node:util";

import {
  createRelayV2BrokerCredentialExternalContinuityOpener,
  type RelayV2BrokerCredentialExternalContinuityOpener,
  type RelayV2BrokerCredentialExternalContinuityOpenerOptions,
} from "./brokerCredentialExternalContinuityOpener.js";
import {
  activateRelayV2BrokerHostWssNodeListenerFreeIngress,
} from "./brokerHostWssNodeListenerFreeIngress.js";
import type {
  RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions,
} from "./brokerHostWssListenerFreeComposition.js";
import type {
  RelayV2BrokerHostWssNodeUpgradeRequestAdapter,
} from "./brokerHostWssNodeUpgradeRequestAdapter.js";

const OPTION_KEYS = Object.freeze([
  "trustedHome",
  "nativeLoader",
  "externalContinuityConfig",
  "externalContinuityAttemptProvider",
  "genesis",
  "sharedRuntimeOptions",
] as const);

export interface RelayV2BrokerHostWssNodeExternalContinuityActivationOptions
  extends RelayV2BrokerCredentialExternalContinuityOpenerOptions {
  readonly sharedRuntimeOptions:
    RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions;
}

export interface RelayV2BrokerHostWssNodeExternalContinuityActivation {
  activate(): Promise<RelayV2BrokerHostWssNodeUpgradeRequestAdapter>;
}

type CapturedOptions = Readonly<Record<(typeof OPTION_KEYS)[number], unknown>>;

function failure(): Error {
  return new Error(
    "Relay v2 Broker Host WSS Node external continuity activation failed",
  );
}

function captureExactOptions(value: unknown): CapturedOptions | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    if (nodeUtilTypes.isProxy(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== OPTION_KEYS.length
      || keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(
        key as (typeof OPTION_KEYS)[number],
      ))
    ) return null;

    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured) as CapturedOptions;
  } catch {
    return null;
  }
}

/**
 * Default-off, inert plan joining the existing E0 opener to the existing B7m
 * listener-free Host ingress. The first valid activation reserves the plan;
 * all authority, ingress, rollback, and close ownership stays in E0/B7m/B7k.
 */
export function createRelayV2BrokerHostWssNodeExternalContinuityActivation(
  options: RelayV2BrokerHostWssNodeExternalContinuityActivationOptions,
): RelayV2BrokerHostWssNodeExternalContinuityActivation {
  const captured = captureExactOptions(options);
  if (captured === null) throw failure();

  let openCredentialAuthority: RelayV2BrokerCredentialExternalContinuityOpener;
  try {
    openCredentialAuthority = createRelayV2BrokerCredentialExternalContinuityOpener(
      Object.freeze(Object.assign(Object.create(null), {
        trustedHome: captured.trustedHome,
        nativeLoader: captured.nativeLoader,
        externalContinuityConfig: captured.externalContinuityConfig,
        externalContinuityAttemptProvider:
          captured.externalContinuityAttemptProvider,
        genesis: captured.genesis,
      })) as RelayV2BrokerCredentialExternalContinuityOpenerOptions,
    );
  } catch {
    throw failure();
  }

  const sharedRuntimeOptions = captured.sharedRuntimeOptions as
    RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions;
  let available = true;
  let activation!: RelayV2BrokerHostWssNodeExternalContinuityActivation;

  const activate = async function activate(
    this: unknown,
  ): Promise<RelayV2BrokerHostWssNodeUpgradeRequestAdapter> {
    if (this !== activation || arguments.length !== 0 || !available) throw failure();
    available = false;

    try {
      return await activateRelayV2BrokerHostWssNodeListenerFreeIngress(
        Object.freeze(Object.assign(Object.create(null), {
          openCredentialAuthority,
          sharedRuntimeOptions,
        })),
      );
    } catch {
      throw failure();
    }
  };

  activation = Object.freeze(Object.assign(Object.create(null), {
    activate,
  })) as RelayV2BrokerHostWssNodeExternalContinuityActivation;
  return activation;
}
