import { types as nodeUtilTypes } from "node:util";

import {
  RelayV2BrokerHostUpgradeDispatchOwner,
  type RelayV2BrokerHostUpgradeDispatchResult,
  type RelayV2BrokerHostUpgradeMetadata,
  type RelayV2BrokerHostUpgradeVerifyPort,
  type RelayV2BrokerHostWssPreflightPort,
} from "./brokerHostUpgradeDispatch.js";
import {
  createRelayV2BrokerHostWssNodeNoServerAdapter,
  type RelayV2BrokerHostWssNodeNoServerAdapter,
} from "./brokerHostWssNodeNoServerAdapter.js";
import type {
  RelayV2BrokerHostPendingUpgradeSocket,
} from "./brokerHostWssUpgradeAuthority.js";
import {
  createRelayV2BrokerHostWssUpgradeAuthority,
  type RelayV2BrokerHostWssUpgradeAuthority,
} from "./brokerHostWssUpgradeAuthority.js";
import type {
  RelayV2BrokerHostWssConnectionHandle,
} from "./brokerHostWssRuntimeComposition.js";
import type {
  RelayV2BrokerActivatedCredentialAuthority,
} from "./brokerClientWssRuntimeComposition.js";
import {
  activateRelayV2BrokerSharedProducerRuntimeComposition,
  createRelayV2BrokerSharedProducerRuntimeComposition,
  type RelayV2BrokerSharedProducerRuntimeComposition,
  type RelayV2BrokerSharedProducerRuntimeActivationOptions,
  type RelayV2BrokerSharedProducerRuntimeCompositionOptions,
} from "./carrierPump.js";

const RAW_FACTORY_KEYS = Object.freeze([
  "verifyV2AccessToken",
  "sharedRuntimeOptions",
] as const);
const CREDENTIAL_ACTIVATED_FACTORY_KEYS = Object.freeze([
  "openCredentialAuthority",
  "sharedRuntimeOptions",
] as const);
const UPGRADE_KEYS = Object.freeze([
  "metadata",
  "request",
  "socket",
  "head",
] as const);
const SHARED_RUNTIME_OPTION_KEYS = Object.freeze([
  "brokerOptions",
  "clientSocketScheduler",
  "deliveryTimeoutMs",
  "closeTimeoutMs",
  "authorizationExpiryScheduleAt",
  "transportCloseDeadlineScheduler",
] as const);
const CLOSING_REJECTION = Object.freeze({
  outcome: "reject" as const,
  status: 503 as const,
});

export type RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions = Readonly<Pick<
  RelayV2BrokerSharedProducerRuntimeCompositionOptions,
  (typeof SHARED_RUNTIME_OPTION_KEYS)[number]
>>;

export interface RelayV2BrokerHostWssListenerFreeCompositionOptions {
  readonly verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  readonly sharedRuntimeOptions: RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions;
}

export type RelayV2BrokerHostWssListenerFreeCredentialAuthority =
  RelayV2BrokerActivatedCredentialAuthority & Readonly<{
    authorizeAccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  }>;

export type RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions =
  Readonly<Pick<
    RelayV2BrokerSharedProducerRuntimeActivationOptions<
      RelayV2BrokerHostWssListenerFreeCredentialAuthority
    >,
    (typeof SHARED_RUNTIME_OPTION_KEYS)[number]
  >>;

export interface RelayV2BrokerHostWssListenerFreeCredentialActivationOptions {
  readonly openCredentialAuthority:
    RelayV2BrokerSharedProducerRuntimeActivationOptions<
      RelayV2BrokerHostWssListenerFreeCredentialAuthority
    >["openCredentialAuthority"];
  readonly sharedRuntimeOptions:
    RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions;
}

export interface RelayV2BrokerHostWssListenerFreeUpgradeInput {
  readonly metadata: RelayV2BrokerHostUpgradeMetadata;
  readonly request: object;
  readonly socket: RelayV2BrokerHostPendingUpgradeSocket;
  readonly head: Uint8Array;
}

export type RelayV2BrokerHostWssListenerFreeUpgradeResult =
  | Extract<RelayV2BrokerHostUpgradeDispatchResult, { outcome: "reject" }>
  | Readonly<{
      outcome: "upgraded";
      connection: RelayV2BrokerHostWssConnectionHandle;
    }>;

export interface RelayV2BrokerHostWssListenerFreeHostUpgrade {
  upgrade(
    input: RelayV2BrokerHostWssListenerFreeUpgradeInput,
  ): Promise<RelayV2BrokerHostWssListenerFreeUpgradeResult>;
}

export interface RelayV2BrokerHostWssListenerFreeComposition {
  readonly hostUpgrade: RelayV2BrokerHostWssListenerFreeHostUpgrade;
  closeAndDrain(): Promise<void>;
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

function failure(): Error {
  return new Error("Relay v2 Broker Host WSS listener-free composition failed");
}

function captureExactDataRecord(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureSharedRuntimeOptions(
  value: unknown,
): RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (
        typeof key !== "string"
        || !SHARED_RUNTIME_OPTION_KEYS.includes(
          key as (typeof SHARED_RUNTIME_OPTION_KEYS)[number],
        )
      ) return null;
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured) as RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions;
  } catch {
    return null;
  }
}

type CapturedDataMethod = Readonly<{
  receiver: object;
  method: Function;
}>;

function captureDataMethod(value: unknown, name: string): CapturedDataMethod | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  let owner: object | null = value;
  try {
    while (owner !== null) {
      if (rejectedProxy(owner)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) {
        if (
          !Object.hasOwn(descriptor, "value")
          || typeof descriptor.value !== "function"
          || rejectedProxy(descriptor.value)
        ) return null;
        return Object.freeze({ receiver: value, method: descriptor.value });
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

async function settleCloseStep(
  step: () => Promise<void>,
  failures: unknown[],
): Promise<void> {
  try {
    await step();
  } catch (error) {
    failures.push(error);
  }
}

type RelayV2BrokerHostWssListenerFreeOpenedRuntime = Readonly<{
  sharedRuntime: RelayV2BrokerSharedProducerRuntimeComposition;
  verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  prepareHostWss: RelayV2BrokerHostWssPreflightPort;
}>;

type RelayV2BrokerHostWssListenerFreeRuntimeOpener = (
  authority: RelayV2BrokerHostWssUpgradeAuthority,
) => Promise<RelayV2BrokerHostWssListenerFreeOpenedRuntime>;

/**
 * File-private common owner for both raw and credential-activated entries.
 * Receipt, socket brand, native port, dispatch, and shared runtime never cross
 * the two-method public facade.
 */
async function openRelayV2BrokerHostWssListenerFreeComposition(
  openRuntime: RelayV2BrokerHostWssListenerFreeRuntimeOpener,
): Promise<RelayV2BrokerHostWssListenerFreeComposition> {
  let adapter: RelayV2BrokerHostWssNodeNoServerAdapter | null = null;
  let authority: RelayV2BrokerHostWssUpgradeAuthority | null = null;
  let sharedRuntime: RelayV2BrokerSharedProducerRuntimeComposition | null = null;

  try {
    adapter = createRelayV2BrokerHostWssNodeNoServerAdapter();
    authority = createRelayV2BrokerHostWssUpgradeAuthority({
      trustedSocketPrototype: adapter.trustedSocketPrototype,
      nativeUpgrade: adapter.nativeUpgrade,
      claimPreparedHostWss(input) {
        if (!sharedRuntime) throw failure();
        return sharedRuntime.hostWssRuntime.claimPreparedHostWss(input);
      },
    });
    const openedRuntime = await openRuntime(authority);
    sharedRuntime = openedRuntime.sharedRuntime;
    const dispatch = new RelayV2BrokerHostUpgradeDispatchOwner({
      verifyV2AccessToken: openedRuntime.verifyV2AccessToken,
      prepareHostWss: openedRuntime.prepareHostWss,
    });

    let lifecycle: "open" | "closing" | "closed" = "open";
    const activeOperations = new Set<Promise<void>>();
    let closePromise: Promise<void> | null = null;
    let hostUpgrade!: RelayV2BrokerHostWssListenerFreeHostUpgrade;
    let composition!: RelayV2BrokerHostWssListenerFreeComposition;

    const upgrade = function upgrade(
      this: unknown,
      input: RelayV2BrokerHostWssListenerFreeUpgradeInput,
    ): Promise<RelayV2BrokerHostWssListenerFreeUpgradeResult> {
      if (this !== hostUpgrade || lifecycle !== "open") {
        const rejected = Promise.reject(failure());
        void rejected.catch(() => undefined);
        return rejected;
      }
      const captured = captureExactDataRecord(input, UPGRADE_KEYS);
      if (!captured) {
        const rejected = Promise.reject(failure());
        void rejected.catch(() => undefined);
        return rejected;
      }

      let resolveOperation!: () => void;
      const operationBarrier = new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
      activeOperations.add(operationBarrier);

      const operation = (async (): Promise<
        RelayV2BrokerHostWssListenerFreeUpgradeResult
      > => {
        try {
          const dispatched = await dispatch.dispatch(
            captured.metadata as RelayV2BrokerHostUpgradeMetadata,
          );
          if (lifecycle !== "open") return CLOSING_REJECTION;
          if (dispatched.outcome === "reject") return dispatched;

          let connection: RelayV2BrokerHostWssConnectionHandle;
          try {
            connection = authority!.handoff.upgrade(Object.freeze({
              admissionReceipt: dispatched.admissionReceipt,
              request: captured.request as object,
              socket: captured.socket as RelayV2BrokerHostPendingUpgradeSocket,
              head: captured.head as Uint8Array,
            }));
          } catch {
            throw failure();
          }
          return Object.freeze({
            outcome: "upgraded",
            connection,
          });
        } catch {
          throw failure();
        } finally {
          activeOperations.delete(operationBarrier);
          resolveOperation();
        }
      })();
      return operation;
    };

    const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
      if (this !== composition) {
        const rejected = Promise.reject(failure());
        void rejected.catch(() => undefined);
        return rejected;
      }
      if (closePromise) return closePromise;
      lifecycle = "closing";
      const operationBarriers = [...activeOperations];
      closePromise = (async () => {
        await Promise.allSettled(operationBarriers);
        const failures: unknown[] = [];
        await settleCloseStep(() => authority!.handoff.closeAndDrain(), failures);
        await settleCloseStep(() => sharedRuntime!.closeAndDrain(), failures);
        await settleCloseStep(() => adapter!.closeAndDrain(), failures);
        lifecycle = "closed";
        if (failures.length > 0) throw failure();
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    };

    hostUpgrade = Object.freeze(Object.assign(Object.create(null), {
      upgrade,
    })) as RelayV2BrokerHostWssListenerFreeHostUpgrade;
    composition = Object.freeze(Object.assign(Object.create(null), {
      hostUpgrade,
      closeAndDrain,
    })) as RelayV2BrokerHostWssListenerFreeComposition;
    return composition;
  } catch {
    const failures: unknown[] = [];
    if (sharedRuntime) {
      await settleCloseStep(() => sharedRuntime!.closeAndDrain(), failures);
    }
    if (authority) {
      await settleCloseStep(() => authority!.handoff.closeAndDrain(), failures);
    }
    if (adapter) await settleCloseStep(() => adapter!.closeAndDrain(), failures);
    throw failure();
  }
}

/**
 * Default-off raw-verifier entry retained for isolated dispatch foundations.
 */
export async function createRelayV2BrokerHostWssListenerFreeComposition(
  options: RelayV2BrokerHostWssListenerFreeCompositionOptions,
): Promise<RelayV2BrokerHostWssListenerFreeComposition> {
  const capturedFactory = captureExactDataRecord(options, RAW_FACTORY_KEYS);
  const verifyV2AccessToken = capturedFactory?.verifyV2AccessToken;
  const sharedRuntimeOptions = captureSharedRuntimeOptions(
    capturedFactory?.sharedRuntimeOptions,
  );
  if (
    typeof verifyV2AccessToken !== "function"
    || rejectedProxy(verifyV2AccessToken)
    || !sharedRuntimeOptions
  ) throw failure();

  return openRelayV2BrokerHostWssListenerFreeComposition(async (authority) => {
    const sharedRuntime = createRelayV2BrokerSharedProducerRuntimeComposition({
      ...sharedRuntimeOptions,
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
    });
    return Object.freeze({
      sharedRuntime,
      verifyV2AccessToken: verifyV2AccessToken as RelayV2BrokerHostUpgradeVerifyPort,
      prepareHostWss: sharedRuntime.hostWssRuntime.prepareHostWss,
    });
  });
}

/**
 * Default-off credential-activated entry. The opener receives only the exact
 * Core live fence; its returned authority supplies both Core auth-control and
 * the Host Upgrade verifier, and remains owned by the shared runtime close.
 */
export async function activateRelayV2BrokerHostWssListenerFreeComposition(
  options: RelayV2BrokerHostWssListenerFreeCredentialActivationOptions,
): Promise<RelayV2BrokerHostWssListenerFreeComposition> {
  const capturedFactory = captureExactDataRecord(
    options,
    CREDENTIAL_ACTIVATED_FACTORY_KEYS,
  );
  const openCredentialAuthority = capturedFactory?.openCredentialAuthority;
  const sharedRuntimeOptions = captureSharedRuntimeOptions(
    capturedFactory?.sharedRuntimeOptions,
  );
  if (
    typeof openCredentialAuthority !== "function"
    || rejectedProxy(openCredentialAuthority)
    || !sharedRuntimeOptions
  ) throw failure();

  return openRelayV2BrokerHostWssListenerFreeComposition(async (authority) => {
    let authorizer: CapturedDataMethod | null = null;
    const activation = await activateRelayV2BrokerSharedProducerRuntimeComposition<
      RelayV2BrokerHostWssListenerFreeCredentialAuthority
    >({
      ...(sharedRuntimeOptions as
        RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions),
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
      async openCredentialAuthority(input) {
        const opened = await Reflect.apply(openCredentialAuthority, undefined, [
          input,
        ]) as RelayV2BrokerHostWssListenerFreeCredentialAuthority;
        authorizer = captureDataMethod(opened, "authorizeAccessToken");
        return opened;
      },
    });

    if (!authorizer) {
      try {
        await activation.sharedRuntime.closeAndDrain();
      } catch {
        // The outer owner still drains B7h and the noServer adapter.
      }
      throw failure();
    }
    const capturedAuthorizer = authorizer;
    const verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort = (
      token,
      expectedRole,
    ) => {
      if (expectedRole !== "host") throw failure();
      return Reflect.apply(capturedAuthorizer.method, capturedAuthorizer.receiver, [
        token,
        "host",
      ]) as ReturnType<RelayV2BrokerHostUpgradeVerifyPort>;
    };
    return Object.freeze({
      sharedRuntime: activation.sharedRuntime,
      verifyV2AccessToken,
      prepareHostWss: activation.sharedRuntime.hostWssRuntime.prepareHostWss,
    });
  });
}
