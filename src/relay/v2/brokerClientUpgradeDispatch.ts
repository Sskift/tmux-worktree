import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  dispatchRelayBrokerUpgrade,
  type RelayBrokerUpgradeDependencies,
  type RelayBrokerUpgradeResult,
} from "./brokerCore.js";
import {
  captureRelayV2BrokerProducerTarget,
  type RelayV2BrokerClientWssCurrentHostPreparePort,
  type RelayV2BrokerClientWssAdmissionReceipt,
  type RelayV2BrokerClientWssPrepareResult,
  type RelayV2BrokerClientWssRuntimeComposition,
} from "./brokerClientWssRuntimeComposition.js";
import type {
  RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";
import {
  captureRelayV2BrokerUpgradeMetadata,
  type RelayV2BrokerUpgradeMetadata,
} from "./brokerUpgradeBoundary.js";

export interface RelayV2BrokerClientUpgradeMetadata extends RelayV2BrokerUpgradeMetadata {}

export type RelayV2BrokerClientUpgradeVerifyPort = Pick<
  RelayBrokerUpgradeDependencies,
  "verifyV2AccessToken"
>["verifyV2AccessToken"];

export type RelayV2BrokerClientWssPreflightPort = Pick<
  RelayV2BrokerClientWssRuntimeComposition,
  "prepareClientWss"
>["prepareClientWss"];

export type RelayV2BrokerClientWssCurrentHostPreflightPort =
  RelayV2BrokerClientWssCurrentHostPreparePort;

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

function roleMismatch(): Error {
  return Object.assign(new Error("Relay v2 Broker client Upgrade requires client role"), {
    code: "ROLE_MISMATCH",
  });
}

function captureOwnerPorts(options: unknown): Readonly<{
  verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
  prepareClientWss: RelayV2BrokerClientWssPreflightPort | null;
  prepareClientWssForCurrentHost: RelayV2BrokerClientWssCurrentHostPreflightPort | null;
}> {
  if (options === null || typeof options !== "object" || isRejectedProxy(options)) {
    throw new Error("invalid Relay v2 Broker client Upgrade dispatch ports");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const verifyV2AccessToken = descriptors.verifyV2AccessToken;
    const prepareClientWss = descriptors.prepareClientWss;
    const prepareClientWssForCurrentHost = descriptors.prepareClientWssForCurrentHost;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2
      || !verifyV2AccessToken
      || !Object.hasOwn(verifyV2AccessToken, "value")
      || typeof verifyV2AccessToken.value !== "function"
      || ((prepareClientWss ? 1 : 0) + (prepareClientWssForCurrentHost ? 1 : 0)) !== 1
      || (prepareClientWss !== undefined && (
        !Object.hasOwn(prepareClientWss, "value")
        || typeof prepareClientWss.value !== "function"
      ))
      || (prepareClientWssForCurrentHost !== undefined && (
        !Object.hasOwn(prepareClientWssForCurrentHost, "value")
        || typeof prepareClientWssForCurrentHost.value !== "function"
      ))
    ) throw new Error("invalid dispatch port descriptor");
    return Object.freeze({
      verifyV2AccessToken: verifyV2AccessToken.value as RelayV2BrokerClientUpgradeVerifyPort,
      prepareClientWss: prepareClientWss
        ? prepareClientWss.value as RelayV2BrokerClientWssPreflightPort
        : null,
      prepareClientWssForCurrentHost: prepareClientWssForCurrentHost
        ? prepareClientWssForCurrentHost.value as RelayV2BrokerClientWssCurrentHostPreflightPort
        : null,
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
  private readonly prepareClientWssForCurrentHost:
    RelayV2BrokerClientWssCurrentHostPreflightPort | null;

  constructor(options: Readonly<{
    verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
  } & (
    | { prepareClientWss: RelayV2BrokerClientWssPreflightPort }
    | { prepareClientWssForCurrentHost: RelayV2BrokerClientWssCurrentHostPreflightPort }
  )>) {
    const ports = captureOwnerPorts(options);
    this.verifyV2AccessToken = ports.verifyV2AccessToken;
    this.prepareClientWss = ports.prepareClientWss as RelayV2BrokerClientWssPreflightPort;
    this.prepareClientWssForCurrentHost = ports.prepareClientWssForCurrentHost;
  }

  async dispatch(
    metadata: RelayV2BrokerClientUpgradeMetadata,
    hostProducerTarget?: RelayV2BrokerProducerTarget,
  ): Promise<RelayV2BrokerClientUpgradeDispatchResult> {
    const capturedHostProducerTarget = this.prepareClientWssForCurrentHost
      ? null
      : captureRelayV2BrokerProducerTarget(hostProducerTarget);
    if (!this.prepareClientWssForCurrentHost && !capturedHostProducerTarget) {
      throw new Error("invalid Relay v2 Broker Host producer target");
    }
    if (this.prepareClientWssForCurrentHost && hostProducerTarget !== undefined) {
      throw new Error("current-Host Relay v2 Broker dispatch does not accept a target");
    }
    const request = captureRelayV2BrokerUpgradeMetadata(metadata, "client");
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

    const prepared = this.prepareClientWssForCurrentHost
      ? this.prepareClientWssForCurrentHost({
          connectionId: randomUUID(),
          trustedAuthContext: upgrade.authContext,
        })
      : this.prepareClientWss({
          connectionId: randomUUID(),
          trustedAuthContext: upgrade.authContext,
          hostProducerTarget: capturedHostProducerTarget!,
        });
    if (prepared.outcome === "reject") return prepared;
    return Object.freeze({
      outcome: "accept",
      selectedProtocol: "tw-relay.v2",
      admissionReceipt: prepared.admissionReceipt,
    });
  }
}
