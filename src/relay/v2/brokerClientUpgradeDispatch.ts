import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  dispatchRelayBrokerUpgrade,
  type RelayBrokerUpgradeDependencies,
  type RelayBrokerUpgradeRequest,
  type RelayBrokerUpgradeResult,
} from "./brokerCore.js";
import {
  captureRelayV2BrokerProducerTarget,
  type RelayV2BrokerClientWssAdmissionReceipt,
  type RelayV2BrokerClientWssPrepareResult,
  type RelayV2BrokerClientWssRuntimeComposition,
} from "./brokerClientWssRuntimeComposition.js";
import type {
  RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";

const UPGRADE_METADATA_KEYS = Object.freeze([
  "pathname",
  "search",
  "authorizationHeaders",
  "legacyQuerySecret",
  "offeredProtocols",
] as const);

export interface RelayV2BrokerClientUpgradeMetadata extends RelayBrokerUpgradeRequest {
  legacyQuerySecret: string | null;
}

export type RelayV2BrokerClientUpgradeVerifyPort = Pick<
  RelayBrokerUpgradeDependencies,
  "verifyV2AccessToken"
>["verifyV2AccessToken"];

export type RelayV2BrokerClientWssPreflightPort = Pick<
  RelayV2BrokerClientWssRuntimeComposition,
  "prepareClientWss"
>["prepareClientWss"];

export type RelayV2BrokerClientUpgradeDispatchResult =
  | Extract<RelayBrokerUpgradeResult, { outcome: "reject" }>
  | Extract<RelayV2BrokerClientWssPrepareResult, { outcome: "reject" }>
  | Readonly<{
      outcome: "accept";
      selectedProtocol: "tw-relay.v2";
      admissionReceipt: RelayV2BrokerClientWssAdmissionReceipt;
    }>;

function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function captureStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || isRejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length;
    if (
      !length
      || !Object.hasOwn(length, "value")
      || !Number.isSafeInteger(length.value)
      || length.value < 0
      || Reflect.ownKeys(descriptors).length !== length.value + 1
    ) return null;
    const captured: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "string"
      ) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureUpgradeMetadata(
  metadata: RelayV2BrokerClientUpgradeMetadata,
): Readonly<RelayV2BrokerClientUpgradeMetadata> {
  if (metadata === null || typeof metadata !== "object" || isRejectedProxy(metadata)) {
    throw new Error("invalid Relay v2 Broker client Upgrade metadata");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(metadata);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== UPGRADE_METADATA_KEYS.length
      || !keys.every((key) => typeof key === "string" && UPGRADE_METADATA_KEYS.includes(
        key as (typeof UPGRADE_METADATA_KEYS)[number],
      ))
    ) throw new Error("invalid Upgrade metadata shape");
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of UPGRADE_METADATA_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid Upgrade metadata descriptor");
      }
      values[key] = descriptor.value;
    }
    const authorizationHeaders = captureStringArray(values.authorizationHeaders);
    const offeredProtocols = captureStringArray(values.offeredProtocols);
    if (
      typeof values.pathname !== "string"
      || typeof values.search !== "string"
      || (values.legacyQuerySecret !== null && typeof values.legacyQuerySecret !== "string")
      || !authorizationHeaders
      || !offeredProtocols
    ) throw new Error("invalid Upgrade metadata value");
    return Object.freeze({
      pathname: values.pathname,
      search: values.search,
      authorizationHeaders,
      legacyQuerySecret: values.legacyQuerySecret,
      offeredProtocols,
    }) as Readonly<RelayV2BrokerClientUpgradeMetadata>;
  } catch {
    throw new Error("invalid Relay v2 Broker client Upgrade metadata");
  }
}

function roleMismatch(): Error {
  return Object.assign(new Error("Relay v2 Broker client Upgrade requires client role"), {
    code: "ROLE_MISMATCH",
  });
}

function captureOwnerPorts(options: unknown): Readonly<{
  verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
  prepareClientWss: RelayV2BrokerClientWssPreflightPort;
}> {
  if (options === null || typeof options !== "object" || isRejectedProxy(options)) {
    throw new Error("invalid Relay v2 Broker client Upgrade dispatch ports");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const verifyV2AccessToken = descriptors.verifyV2AccessToken;
    const prepareClientWss = descriptors.prepareClientWss;
    if (
      !verifyV2AccessToken
      || !Object.hasOwn(verifyV2AccessToken, "value")
      || typeof verifyV2AccessToken.value !== "function"
      || !prepareClientWss
      || !Object.hasOwn(prepareClientWss, "value")
      || typeof prepareClientWss.value !== "function"
    ) throw new Error("invalid dispatch port descriptor");
    return Object.freeze({
      verifyV2AccessToken: verifyV2AccessToken.value as RelayV2BrokerClientUpgradeVerifyPort,
      prepareClientWss: prepareClientWss.value as RelayV2BrokerClientWssPreflightPort,
    });
  } catch {
    throw new Error("invalid Relay v2 Broker client Upgrade dispatch ports");
  }
}

/**
 * Default-off pre-101 owner. It only composes the canonical Upgrade dispatch
 * with the existing client WSS preflight and has no listener/server callsite.
 */
export class RelayV2BrokerClientUpgradeDispatchOwner {
  private readonly verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
  private readonly prepareClientWss: RelayV2BrokerClientWssPreflightPort;

  constructor(options: {
    verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
    prepareClientWss: RelayV2BrokerClientWssPreflightPort;
  }) {
    const ports = captureOwnerPorts(options);
    this.verifyV2AccessToken = ports.verifyV2AccessToken;
    this.prepareClientWss = ports.prepareClientWss;
  }

  async dispatch(
    metadata: RelayV2BrokerClientUpgradeMetadata,
    hostProducerTarget: RelayV2BrokerProducerTarget,
  ): Promise<RelayV2BrokerClientUpgradeDispatchResult> {
    const capturedHostProducerTarget = captureRelayV2BrokerProducerTarget(
      hostProducerTarget,
    );
    if (!capturedHostProducerTarget) {
      throw new Error("invalid Relay v2 Broker Host producer target");
    }
    const request = captureUpgradeMetadata(metadata);
    const upgrade = await dispatchRelayBrokerUpgrade(request, {
      verifyLegacySecret: () => false,
      verifyV2AccessToken: (token, expectedRole) => {
        if (expectedRole !== "client") throw roleMismatch();
        return this.verifyV2AccessToken(token, expectedRole);
      },
    });
    if (upgrade.outcome === "reject") return upgrade;
    if (
      upgrade.stack !== "v2"
      || upgrade.role !== "client"
      || upgrade.selectedProtocol !== "tw-relay.v2"
    ) throw new Error("Relay v2 Broker client Upgrade dispatch invariant failed");

    const prepared = this.prepareClientWss({
      connectionId: randomUUID(),
      trustedAuthContext: upgrade.authContext,
      hostProducerTarget: capturedHostProducerTarget,
    });
    if (prepared.outcome === "reject") return prepared;
    return Object.freeze({
      outcome: "accept",
      selectedProtocol: "tw-relay.v2",
      admissionReceipt: prepared.admissionReceipt,
    });
  }
}
