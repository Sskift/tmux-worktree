import { types as nodeUtilTypes } from "node:util";

import {
  createRelayV2BrokerClientWssNodeListenerFreeIngress,
  type RelayV2BrokerClientWssNodeListenerFreeIngress,
  type RelayV2BrokerClientWssNodeUpgradeRequestInput,
  type RelayV2BrokerClientWssNodePrivateIngressChild,
} from "./brokerClientWssNodeListenerFreeIngress.js";
import type {
  RelayV2BrokerClientUpgradeVerifyPort,
} from "./brokerClientUpgradeDispatch.js";
import {
  RelayV2BrokerHostUpgradeDispatchOwner,
  type RelayV2BrokerHostUpgradeDispatchResult,
  type RelayV2BrokerHostUpgradeMetadata,
  type RelayV2BrokerHostUpgradeVerifyPort,
  type RelayV2BrokerHostWssPreflightPort,
} from "./brokerHostUpgradeDispatch.js";
import {
  createRelayV2BrokerHostWssNodeUpgradeRequestAdapter,
  type RelayV2BrokerHostWssNodeUpgradeRequestInput,
  type RelayV2BrokerHostWssNodeUpgradeRequestAdapter,
} from "./brokerHostWssNodeUpgradeRequestAdapter.js";
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
  RelayV2BrokerHostWssRuntimeFacade,
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
  "bindOptionalCapabilityReadinessPort",
] as const);
const CLOSING_REJECTION = Object.freeze({
  outcome: "reject" as const,
  status: 503 as const,
});
const COMBINED_FAILURE_MESSAGE =
  "Relay v2 Broker combined WSS Node listener-free composition failed";

export type RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions = Readonly<Pick<
  RelayV2BrokerSharedProducerRuntimeCompositionOptions,
  (typeof SHARED_RUNTIME_OPTION_KEYS)[number]
>>;

export interface RelayV2BrokerHostWssListenerFreeCompositionOptions {
  readonly verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  readonly sharedRuntimeOptions: RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions;
}

export interface RelayV2BrokerCombinedWssNodeListenerFreeCompositionOptions {
  readonly verifyV2AccessToken:
    RelayV2BrokerHostUpgradeVerifyPort & RelayV2BrokerClientUpgradeVerifyPort;
  readonly sharedRuntimeOptions: RelayV2BrokerHostWssListenerFreeSharedRuntimeOptions;
}

export type RelayV2BrokerCombinedWssNodeListenerFreeCredentialAuthority =
  RelayV2BrokerActivatedCredentialAuthority & Readonly<{
    authorizeAccessToken:
      RelayV2BrokerHostUpgradeVerifyPort & RelayV2BrokerClientUpgradeVerifyPort;
  }>;

export type RelayV2BrokerCombinedWssNodeListenerFreeCredentialSharedRuntimeOptions =
  Readonly<Pick<
    RelayV2BrokerSharedProducerRuntimeActivationOptions<
      RelayV2BrokerCombinedWssNodeListenerFreeCredentialAuthority
    >,
    (typeof SHARED_RUNTIME_OPTION_KEYS)[number]
  >>;

export interface RelayV2BrokerCombinedWssNodeListenerFreeCredentialActivationOptions {
  readonly openCredentialAuthority:
    RelayV2BrokerSharedProducerRuntimeActivationOptions<
      RelayV2BrokerCombinedWssNodeListenerFreeCredentialAuthority
    >["openCredentialAuthority"];
  readonly sharedRuntimeOptions:
    RelayV2BrokerCombinedWssNodeListenerFreeCredentialSharedRuntimeOptions;
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

export interface RelayV2BrokerCombinedWssNodeListenerFreeComposition {
  handleHostUpgradeRequest(
    input: RelayV2BrokerHostWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected">;
  handleClientUpgradeRequest(
    input: RelayV2BrokerClientWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected">;
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

function combinedFailure(): Error {
  return new Error(COMBINED_FAILURE_MESSAGE);
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

async function drainPrivateIngressChildren(
  children: readonly (RelayV2BrokerPrivateIngressChild | null)[],
): Promise<void> {
  const closes = children.flatMap((child) => {
    if (!child) return [];
    const captured = captureDataMethod(child, "closeAndDrain");
    if (!captured) return [Promise.reject(failure())];
    try {
      const pending = Reflect.apply(captured.method, captured.receiver, []);
      return [nodeUtilTypes.isPromise(pending)
        ? pending as Promise<void>
        : Promise.reject(failure())];
    } catch {
      return [Promise.reject(failure())];
    }
  });
  await Promise.allSettled(closes);
}

type RelayV2BrokerHostWssListenerFreeOpenedRuntime = Readonly<{
  sharedRuntime: RelayV2BrokerSharedProducerRuntimeComposition;
  verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
}>;

type RelayV2BrokerHostWssPrivateIngressRuntime = Readonly<Pick<
  RelayV2BrokerHostWssRuntimeFacade,
  "prepareHostWss" | "claimPreparedHostWss" | "attachPreparedHostWss"
>>;

type RelayV2BrokerPrivateIngressInstaller = NonNullable<
  RelayV2BrokerSharedProducerRuntimeCompositionOptions["installPrivateIngressChildren"]
>;

type RelayV2BrokerPrivateIngressChild = Readonly<{
  closeAndDrain(): Promise<void>;
}>;

type RelayV2BrokerHostPrivateIngressInstaller = (
  runtime: RelayV2BrokerHostWssPrivateIngressRuntime,
) => RelayV2BrokerPrivateIngressChild;

type RelayV2BrokerHostWssListenerFreeRuntimeOpener = (
  authority: RelayV2BrokerHostWssUpgradeAuthority,
  installHostIngress: RelayV2BrokerHostPrivateIngressInstaller,
) => Promise<RelayV2BrokerHostWssListenerFreeOpenedRuntime>;

function createAbsentClientIngressChild(): RelayV2BrokerPrivateIngressChild {
  let child!: RelayV2BrokerPrivateIngressChild;
  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    return this === child ? Promise.resolve() : Promise.reject(failure());
  };
  child = Object.freeze(Object.assign(Object.create(null), {
    closeAndDrain,
  })) as RelayV2BrokerPrivateIngressChild;
  return child;
}

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
  let privateHostRuntime: RelayV2BrokerHostWssPrivateIngressRuntime | null = null;
  let lifecycle: "open" | "closing" | "closed" = "open";
  const activeOperations = new Set<Promise<void>>();
  let childClose: Promise<void> | null = null;
  let publicClose: Promise<void> | null = null;
  let hostUpgrade!: RelayV2BrokerHostWssListenerFreeHostUpgrade;
  let composition!: RelayV2BrokerHostWssListenerFreeComposition;

  const closeHostIngress = (): Promise<void> => {
    if (childClose) return childClose;
    lifecycle = "closing";
    const operationBarriers = [...activeOperations];
    childClose = (async () => {
      await Promise.allSettled(operationBarriers);
      const failures: unknown[] = [];
      if (authority) {
        await settleCloseStep(() => authority!.handoff.closeAndDrain(), failures);
      }
      if (adapter) await settleCloseStep(() => adapter!.closeAndDrain(), failures);
      lifecycle = "closed";
      if (failures.length > 0) throw failure();
    })();
    void childClose.catch(() => undefined);
    return childClose;
  };

  let hostIngressChild!: Readonly<{ closeAndDrain(): Promise<void> }>;
  const hostChildClose = function hostChildClose(this: unknown): Promise<void> {
    return this === hostIngressChild ? closeHostIngress() : Promise.reject(failure());
  };
  hostIngressChild = Object.freeze(Object.assign(Object.create(null), {
    closeAndDrain: hostChildClose,
  }));
  const installHostIngress: RelayV2BrokerHostPrivateIngressInstaller = (
    runtime,
  ) => {
    if (privateHostRuntime !== null) throw failure();
    privateHostRuntime = runtime;
    return hostIngressChild;
  };

  try {
    adapter = createRelayV2BrokerHostWssNodeNoServerAdapter();
    authority = createRelayV2BrokerHostWssUpgradeAuthority({
      trustedSocketPrototype: adapter.trustedSocketPrototype,
      nativeUpgrade: adapter.nativeUpgrade,
      claimPreparedHostWss(input) {
        if (!privateHostRuntime) throw failure();
        return privateHostRuntime.claimPreparedHostWss(input);
      },
    });
    const openedRuntime = await openRuntime(authority, installHostIngress);
    sharedRuntime = openedRuntime.sharedRuntime;
    if (!privateHostRuntime) throw failure();
    const dispatch = new RelayV2BrokerHostUpgradeDispatchOwner({
      verifyV2AccessToken: openedRuntime.verifyV2AccessToken,
      prepareHostWss: privateHostRuntime.prepareHostWss,
    });

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
      if (publicClose) return publicClose;
      const totalClose = sharedRuntime!.closeAndDrain();
      publicClose = totalClose.catch(() => { throw failure(); });
      void publicClose.catch(() => undefined);
      return publicClose;
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
    await settleCloseStep(closeHostIngress, failures);
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

  return openRelayV2BrokerHostWssListenerFreeComposition(async (
    authority,
    installHostIngress,
  ) => {
    const absentClientIngress = createAbsentClientIngressChild();
    const installPrivateIngressChildren: RelayV2BrokerPrivateIngressInstaller = (
      ports,
    ) => Object.freeze(Object.assign(Object.create(null), {
      hostIngress: installHostIngress(ports.hostWssRuntime),
      // This Host-only foundation intentionally installs no client request path.
      clientIngress: absentClientIngress,
    }));
    const sharedRuntime = createRelayV2BrokerSharedProducerRuntimeComposition({
      ...sharedRuntimeOptions,
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
      installPrivateIngressChildren,
    });
    return Object.freeze({
      sharedRuntime,
      verifyV2AccessToken: verifyV2AccessToken as RelayV2BrokerHostUpgradeVerifyPort,
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

  return openRelayV2BrokerHostWssListenerFreeComposition(async (
    authority,
    installHostIngress,
  ) => {
    const absentClientIngress = createAbsentClientIngressChild();
    const installPrivateIngressChildren: RelayV2BrokerPrivateIngressInstaller = (
      ports,
    ) => Object.freeze(Object.assign(Object.create(null), {
      hostIngress: installHostIngress(ports.hostWssRuntime),
      // Credential-activated Host-only composition still has no client path.
      clientIngress: absentClientIngress,
    }));
    let authorizer: CapturedDataMethod | null = null;
    const activation = await activateRelayV2BrokerSharedProducerRuntimeComposition<
      RelayV2BrokerHostWssListenerFreeCredentialAuthority
    >({
      ...(sharedRuntimeOptions as
        RelayV2BrokerHostWssListenerFreeCredentialSharedRuntimeOptions),
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
      installPrivateIngressChildren,
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
    });
  });
}

type RelayV2BrokerCombinedRoleVerifiers = Readonly<{
  host: RelayV2BrokerHostUpgradeVerifyPort;
  client: RelayV2BrokerClientUpgradeVerifyPort;
}>;

type RelayV2BrokerCombinedPrivateIngressState = {
  hostChild: RelayV2BrokerPrivateIngressChild | null;
  clientChild: RelayV2BrokerClientWssNodePrivateIngressChild | null;
  clientIngress: RelayV2BrokerClientWssNodeListenerFreeIngress | null;
};

type RelayV2BrokerCombinedPrivateIngressInstallerFactory = (
  verifyClientV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort,
) => RelayV2BrokerPrivateIngressInstaller;

type RelayV2BrokerCombinedOpenedRuntime = Readonly<{
  sharedRuntime: RelayV2BrokerSharedProducerRuntimeComposition;
  verifyHostV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
}>;

type RelayV2BrokerCombinedRuntimeOpener = (
  authority: RelayV2BrokerHostWssUpgradeAuthority,
  createPrivateIngressInstaller:
    RelayV2BrokerCombinedPrivateIngressInstallerFactory,
) => Promise<RelayV2BrokerCombinedOpenedRuntime>;

function createRelayV2BrokerCombinedRoleVerifiers(
  authorize: (
    token: string,
    expectedRole: "host" | "client",
  ) => ReturnType<RelayV2BrokerHostUpgradeVerifyPort>,
): RelayV2BrokerCombinedRoleVerifiers {
  const host: RelayV2BrokerHostUpgradeVerifyPort = (token, expectedRole) => {
    if (expectedRole !== "host") throw combinedFailure();
    return authorize(token, "host");
  };
  const client: RelayV2BrokerClientUpgradeVerifyPort = (token, expectedRole) => {
    if (expectedRole !== "client") throw combinedFailure();
    return authorize(token, "client");
  };
  return Object.freeze({ host, client });
}

function createRelayV2BrokerCombinedPrivateIngressInstaller(
  state: RelayV2BrokerCombinedPrivateIngressState,
  installHostIngress: RelayV2BrokerHostPrivateIngressInstaller,
  verifyClientV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort,
): RelayV2BrokerPrivateIngressInstaller {
  return (ports) => {
    if (
      state.hostChild !== null
      || state.clientChild !== null
      || state.clientIngress !== null
    ) throw combinedFailure();

    state.hostChild = installHostIngress(ports.hostWssRuntime);
    const clientIngress = createRelayV2BrokerClientWssNodeListenerFreeIngress(
      Object.freeze(Object.assign(Object.create(null), {
        verifyV2AccessToken: verifyClientV2AccessToken,
        runtime: ports.clientWssRuntime,
      })),
      (child) => {
        if (state.clientChild !== null) throw combinedFailure();
        state.clientChild = child;
      },
    );
    state.clientIngress = clientIngress;
    if (state.clientChild === null) throw combinedFailure();
    return Object.freeze(Object.assign(Object.create(null), {
      hostIngress: state.hostChild,
      clientIngress: state.clientChild,
    }));
  };
}

function createRelayV2BrokerCombinedFacade(
  hostRequestAdapter: RelayV2BrokerHostWssNodeUpgradeRequestAdapter,
  clientIngress: RelayV2BrokerClientWssNodeListenerFreeIngress,
): RelayV2BrokerCombinedWssNodeListenerFreeComposition {
  const hostHandler = captureDataMethod(hostRequestAdapter, "handleUpgradeRequest");
  const clientHandler = captureDataMethod(clientIngress, "handleUpgradeRequest");
  const totalClose = captureDataMethod(hostRequestAdapter, "closeAndDrain");
  if (!hostHandler || !clientHandler || !totalClose) throw combinedFailure();

  let lifecycle: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | null = null;
  let composition!: RelayV2BrokerCombinedWssNodeListenerFreeComposition;

  const handleHostUpgradeRequest = function handleHostUpgradeRequest(
    this: unknown,
    input: RelayV2BrokerHostWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected"> {
    if (this !== composition || lifecycle !== "open") {
      const rejected = Promise.reject<"upgraded" | "rejected">(combinedFailure());
      void rejected.catch(() => undefined);
      return rejected;
    }
    return (async () => {
      try {
        const pending = Reflect.apply(hostHandler.method, hostHandler.receiver, [input]);
        if (!nodeUtilTypes.isPromise(pending)) throw combinedFailure();
        return await pending as "upgraded" | "rejected";
      } catch {
        throw combinedFailure();
      }
    })();
  };

  const handleClientUpgradeRequest = function handleClientUpgradeRequest(
    this: unknown,
    input: RelayV2BrokerClientWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected"> {
    if (this !== composition || lifecycle !== "open") {
      const rejected = Promise.reject<"upgraded" | "rejected">(combinedFailure());
      void rejected.catch(() => undefined);
      return rejected;
    }
    return (async () => {
      try {
        const pending = Reflect.apply(clientHandler.method, clientHandler.receiver, [input]);
        if (!nodeUtilTypes.isPromise(pending)) throw combinedFailure();
        return await pending as "upgraded" | "rejected";
      } catch {
        throw combinedFailure();
      }
    })();
  };

  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    if (this !== composition) {
      const rejected = Promise.reject(combinedFailure());
      void rejected.catch(() => undefined);
      return rejected;
    }
    if (closePromise) return closePromise;
    lifecycle = "closing";
    closePromise = (async () => {
      try {
        const pending = Reflect.apply(totalClose.method, totalClose.receiver, []);
        if (!nodeUtilTypes.isPromise(pending)) throw combinedFailure();
        await pending;
      } catch {
        throw combinedFailure();
      } finally {
        lifecycle = "closed";
      }
    })();
    void closePromise.catch(() => undefined);
    return closePromise;
  };

  composition = Object.freeze(Object.assign(Object.create(null), {
    handleHostUpgradeRequest,
    handleClientUpgradeRequest,
    closeAndDrain,
  })) as RelayV2BrokerCombinedWssNodeListenerFreeComposition;
  return composition;
}

async function closeRelayV2BrokerCombinedConstruction(
  hostRequestAdapter: RelayV2BrokerHostWssNodeUpgradeRequestAdapter | null,
  hostComposition: RelayV2BrokerHostWssListenerFreeComposition | null,
  state: RelayV2BrokerCombinedPrivateIngressState,
): Promise<void> {
  if (hostRequestAdapter) {
    const close = captureDataMethod(hostRequestAdapter, "closeAndDrain");
    if (close) {
      try {
        const pending = Reflect.apply(close.method, close.receiver, []);
        if (nodeUtilTypes.isPromise(pending)) await pending;
      } catch {
        // Continue to the generic construction failure.
      }
    }
    return;
  }
  if (hostComposition) {
    try {
      await hostComposition.closeAndDrain();
    } catch {
      // Continue to the generic construction failure.
    }
    return;
  }
  await drainPrivateIngressChildren([state.hostChild, state.clientChild]);
}

/**
 * File-private common child and facade owner for raw and credential-activated
 * combined entries. Both strategies install their Host and client ingress on
 * one shared runtime and reach the same total close owner.
 */
async function openRelayV2BrokerCombinedWssNodeListenerFreeComposition(
  openRuntime: RelayV2BrokerCombinedRuntimeOpener,
): Promise<RelayV2BrokerCombinedWssNodeListenerFreeComposition> {
  const state: RelayV2BrokerCombinedPrivateIngressState = {
    hostChild: null,
    clientChild: null,
    clientIngress: null,
  };
  let hostComposition: RelayV2BrokerHostWssListenerFreeComposition | null = null;
  let hostRequestAdapter: RelayV2BrokerHostWssNodeUpgradeRequestAdapter | null = null;

  try {
    hostComposition = await openRelayV2BrokerHostWssListenerFreeComposition(async (
      authority,
      installHostIngress,
    ) => {
      let openedSharedRuntime: RelayV2BrokerSharedProducerRuntimeComposition | null = null;
      let installerCreated = false;
      try {
        const opened = await openRuntime(
          authority,
          (verifyClientV2AccessToken) => {
            if (installerCreated) throw combinedFailure();
            installerCreated = true;
            return createRelayV2BrokerCombinedPrivateIngressInstaller(
              state,
              installHostIngress,
              verifyClientV2AccessToken,
            );
          },
        );
        openedSharedRuntime = opened.sharedRuntime;
        if (
          !installerCreated
          || state.clientIngress === null
          || state.hostChild === null
          || state.clientChild === null
        ) throw combinedFailure();
        return Object.freeze({
          sharedRuntime: openedSharedRuntime,
          verifyV2AccessToken: opened.verifyHostV2AccessToken,
        });
      } catch {
        if (openedSharedRuntime) {
          try {
            await openedSharedRuntime.closeAndDrain();
          } catch {
            // The public failure remains generic after all owned close attempts.
          }
        } else {
          await drainPrivateIngressChildren([state.hostChild, state.clientChild]);
        }
        throw combinedFailure();
      }
    });

    if (!state.clientIngress) throw combinedFailure();
    hostRequestAdapter = createRelayV2BrokerHostWssNodeUpgradeRequestAdapter(
      hostComposition,
    );
    return createRelayV2BrokerCombinedFacade(
      hostRequestAdapter,
      state.clientIngress,
    );
  } catch {
    await closeRelayV2BrokerCombinedConstruction(
      hostRequestAdapter,
      hostComposition,
      state,
    );
    throw combinedFailure();
  }
}

/**
 * Default-off outer Node Upgrade composition for one raw-verifier shared
 * Broker owner. It creates no HTTP(S) listener, bound server/socket/port,
 * production configuration, capability, enrollment, or protocol fallback.
 */
export async function createRelayV2BrokerCombinedWssNodeListenerFreeComposition(
  options: RelayV2BrokerCombinedWssNodeListenerFreeCompositionOptions,
): Promise<RelayV2BrokerCombinedWssNodeListenerFreeComposition> {
  const capturedFactory = captureExactDataRecord(options, RAW_FACTORY_KEYS);
  const verifier = capturedFactory?.verifyV2AccessToken;
  const sharedRuntimeOptions = captureSharedRuntimeOptions(
    capturedFactory?.sharedRuntimeOptions,
  );
  if (
    typeof verifier !== "function"
    || rejectedProxy(verifier)
    || !sharedRuntimeOptions
  ) throw combinedFailure();

  const verifiers = createRelayV2BrokerCombinedRoleVerifiers((token, role) => (
    Reflect.apply(verifier, undefined, [token, role]) as
      ReturnType<RelayV2BrokerHostUpgradeVerifyPort>
  ));
  return openRelayV2BrokerCombinedWssNodeListenerFreeComposition(async (
    authority,
    createPrivateIngressInstaller,
  ) => {
    const sharedRuntime = createRelayV2BrokerSharedProducerRuntimeComposition({
      ...sharedRuntimeOptions,
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
      installPrivateIngressChildren: createPrivateIngressInstaller(verifiers.client),
    });
    return Object.freeze({
      sharedRuntime,
      verifyHostV2AccessToken: verifiers.host,
    });
  });
}

/**
 * Default-off credential-activated combined outer. The credential opener sees
 * only the exact Core live fence. Its ready authority supplies the captured
 * Host/client authorizer while the shared activation remains its close owner.
 */
export async function activateRelayV2BrokerCombinedWssNodeListenerFreeComposition(
  options: RelayV2BrokerCombinedWssNodeListenerFreeCredentialActivationOptions,
): Promise<RelayV2BrokerCombinedWssNodeListenerFreeComposition> {
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
  ) throw combinedFailure();

  return openRelayV2BrokerCombinedWssNodeListenerFreeComposition(async (
    authority,
    createPrivateIngressInstaller,
  ) => {
    let authorizer: CapturedDataMethod | null = null;
    const verifiers = createRelayV2BrokerCombinedRoleVerifiers((token, role) => {
      if (!authorizer) throw combinedFailure();
      return Reflect.apply(authorizer.method, authorizer.receiver, [token, role]) as
        ReturnType<RelayV2BrokerHostUpgradeVerifyPort>;
    });
    const activation = await activateRelayV2BrokerSharedProducerRuntimeComposition<
      RelayV2BrokerCombinedWssNodeListenerFreeCredentialAuthority
    >({
      ...(sharedRuntimeOptions as
        RelayV2BrokerCombinedWssNodeListenerFreeCredentialSharedRuntimeOptions),
      hostWssTrustedSocketPrototype: authority.trustedSocketPrototype,
      hostWssTrustedSocketBrand: authority.trustedSocketBrand,
      installPrivateIngressChildren: createPrivateIngressInstaller(verifiers.client),
      async openCredentialAuthority(input) {
        const opened = await Reflect.apply(openCredentialAuthority, undefined, [
          input,
        ]) as RelayV2BrokerCombinedWssNodeListenerFreeCredentialAuthority;
        authorizer = captureDataMethod(opened, "authorizeAccessToken");
        return opened;
      },
    });

    if (!authorizer) {
      try {
        await activation.sharedRuntime.closeAndDrain();
      } catch {
        // Shared activation still owns every rollback close attempt.
      }
      throw combinedFailure();
    }
    return Object.freeze({
      sharedRuntime: activation.sharedRuntime,
      verifyHostV2AccessToken: verifiers.host,
    });
  });
}
