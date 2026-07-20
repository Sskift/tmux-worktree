import { types as nodeUtilTypes } from "node:util";

import {
  dispatchRelayBrokerUpgrade,
  type RelayBrokerUpgradeDependencies,
  type RelayBrokerUpgradeResult,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostWssAdmissionReceipt,
  type RelayV2BrokerHostWssPrepareResult,
  type RelayV2BrokerHostWssRuntimeFacade,
} from "./brokerHostWssRuntimeComposition.js";
import {
  captureRelayV2BrokerUpgradeMetadata,
  type RelayV2BrokerUpgradeMetadata,
} from "./brokerUpgradeBoundary.js";

export interface RelayV2BrokerHostUpgradeMetadata extends RelayV2BrokerUpgradeMetadata {}

export type RelayV2BrokerHostUpgradeVerifyPort = Pick<
  RelayBrokerUpgradeDependencies,
  "verifyV2AccessToken"
>["verifyV2AccessToken"];

export type RelayV2BrokerHostWssPreflightPort = Pick<
  RelayV2BrokerHostWssRuntimeFacade,
  "prepareHostWss"
>["prepareHostWss"];

export type RelayV2BrokerHostUpgradeDispatchResult =
  | Extract<RelayBrokerUpgradeResult, { outcome: "reject" }>
  | Extract<RelayV2BrokerHostWssPrepareResult, { outcome: "reject" }>
  | Readonly<{
      outcome: "accept";
      selectedProtocol: "tw-relay.host.v2";
      admissionReceipt: RelayV2BrokerHostWssAdmissionReceipt;
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
  return Object.assign(new Error("Relay v2 Broker Host Upgrade requires host role"), {
    code: "ROLE_MISMATCH",
  });
}

function captureOwnerPorts(options: unknown): Readonly<{
  verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  prepareHostWss: RelayV2BrokerHostWssPreflightPort;
}> {
  if (options === null || typeof options !== "object" || isRejectedProxy(options)) {
    throw new Error("invalid Relay v2 Broker Host Upgrade dispatch ports");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const verifyV2AccessToken = descriptors.verifyV2AccessToken;
    const prepareHostWss = descriptors.prepareHostWss;
    if (
      !verifyV2AccessToken
      || !Object.hasOwn(verifyV2AccessToken, "value")
      || typeof verifyV2AccessToken.value !== "function"
      || !prepareHostWss
      || !Object.hasOwn(prepareHostWss, "value")
      || typeof prepareHostWss.value !== "function"
    ) throw new Error("invalid dispatch port descriptor");
    return Object.freeze({
      verifyV2AccessToken: verifyV2AccessToken.value as RelayV2BrokerHostUpgradeVerifyPort,
      prepareHostWss: prepareHostWss.value as RelayV2BrokerHostWssPreflightPort,
    });
  } catch {
    throw new Error("invalid Relay v2 Broker Host Upgrade dispatch ports");
  }
}

/**
 * Default-off pre-101 owner. It selects only the v2 Host verifier and hands
 * the closed authorization cut to the existing Host WSS preflight.
 */
export class RelayV2BrokerHostUpgradeDispatchOwner {
  private readonly verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
  private readonly prepareHostWss: RelayV2BrokerHostWssPreflightPort;

  constructor(options: {
    verifyV2AccessToken: RelayV2BrokerHostUpgradeVerifyPort;
    prepareHostWss: RelayV2BrokerHostWssPreflightPort;
  }) {
    const ports = captureOwnerPorts(options);
    this.verifyV2AccessToken = ports.verifyV2AccessToken;
    this.prepareHostWss = ports.prepareHostWss;
  }

  async dispatch(
    metadata: RelayV2BrokerHostUpgradeMetadata,
  ): Promise<RelayV2BrokerHostUpgradeDispatchResult> {
    const request = captureRelayV2BrokerUpgradeMetadata(metadata, "host");
    const upgrade = await dispatchRelayBrokerUpgrade(request, {
      verifyLegacySecret: () => false,
      verifyV2AccessToken: (token, expectedRole) => {
        if (expectedRole !== "host") throw roleMismatch();
        return this.verifyV2AccessToken(token, expectedRole);
      },
    });
    if (upgrade.outcome === "reject") return upgrade;
    if (
      upgrade.stack !== "v2"
      || upgrade.role !== "host"
      || upgrade.selectedProtocol !== "tw-relay.host.v2"
    ) throw new Error("Relay v2 Broker Host Upgrade dispatch invariant failed");

    const prepared = this.prepareHostWss({
      trustedAuthContext: upgrade.authContext,
    });
    if (prepared.outcome === "reject") return prepared;
    return Object.freeze({
      outcome: "accept",
      selectedProtocol: "tw-relay.host.v2",
      admissionReceipt: prepared.receipt,
    });
  }
}
