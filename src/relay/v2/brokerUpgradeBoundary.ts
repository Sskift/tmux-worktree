import { types as nodeUtilTypes } from "node:util";

import type { RelayBrokerUpgradeRequest } from "./brokerCore.js";

const UPGRADE_METADATA_KEYS = Object.freeze([
  "pathname",
  "search",
  "authorizationHeaders",
  "legacyQuerySecret",
  "offeredProtocols",
] as const);

export interface RelayV2BrokerUpgradeMetadata extends RelayBrokerUpgradeRequest {
  legacyQuerySecret: string | null;
}

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

/** Captures the complete pre-101 HTTP metadata without invoking caller accessors. */
export function captureRelayV2BrokerUpgradeMetadata(
  metadata: RelayV2BrokerUpgradeMetadata,
  owner: "client" | "host",
): Readonly<RelayV2BrokerUpgradeMetadata> {
  const invalid = owner === "client"
    ? "invalid Relay v2 Broker client Upgrade metadata"
    : owner === "host"
      ? "invalid Relay v2 Broker host Upgrade metadata"
      : "invalid Relay v2 Broker Upgrade metadata";
  if (metadata === null || typeof metadata !== "object" || isRejectedProxy(metadata)) {
    throw new Error(invalid);
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
    }) as Readonly<RelayV2BrokerUpgradeMetadata>;
  } catch {
    throw new Error(invalid);
  }
}
