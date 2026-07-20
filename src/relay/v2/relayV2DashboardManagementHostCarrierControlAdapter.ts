import { Buffer } from "node:buffer";
import {
  RelayV2DashboardManagementAuthorityFailure,
  type RelayV2DashboardManagementCarrierControlPort,
  type RelayV2DashboardManagementEnrollmentReceipt,
  type RelayV2DashboardManagementGrantRevocationReceipt,
} from "./relayV2DashboardManagementAuthority.js";
import {
  RelayV2HostCarrierDashboardManagementControlOwner,
  type RelayV2HostCarrierDashboardManagementControlErrorCode,
} from "./hostCarrier.js";

type DataRecord = Record<string, unknown>;

export interface RelayV2DashboardManagementHostCarrierControlAdapterOptions {
  readonly owner: RelayV2HostCarrierDashboardManagementControlOwner;
}

export class RelayV2DashboardManagementHostCarrierControlAdapterClosedError extends Error {
  constructor() {
    super("Relay v2 Dashboard host carrier control adapter closed");
    this.name = "RelayV2DashboardManagementHostCarrierControlAdapterClosedError";
  }
}

function closed(): never {
  throw new RelayV2DashboardManagementHostCarrierControlAdapterClosedError();
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value)) return closed();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return closed();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) return closed();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function identifier(value: unknown, maximumBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) return closed();
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return closed();
  return value as number;
}

function managementUrl(
  value: unknown,
  protocol: "https:" | "wss:",
  pathname: "/" | "/client",
): string {
  if (typeof value !== "string"
    || !/^[\x21-\x7e]+$/.test(value)
    || Buffer.byteLength(value, "utf8") > 2_048
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) return closed();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return closed();
  }
  const prefix = protocol === "https:" ? "https://" : "wss://";
  const authority = value.startsWith(prefix)
    ? value.slice(prefix.length).split("/", 1)[0]
    : "";
  if (parsed.protocol !== protocol
    || parsed.hostname.length === 0
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || authority.endsWith(":")
    || parsed.pathname !== pathname) return closed();
  return value;
}

function enrollmentCode(value: unknown): string {
  if (typeof value !== "string"
    || !value.startsWith("twenroll2.")
    || value.length === "twenroll2.".length
    || Buffer.byteLength(value, "utf8") > 512
    || value.trim() !== value
    || /[\0\r\n]/.test(value)) return closed();
  return value;
}

function parseCreateInput(value: unknown): Readonly<{
  requestId: string;
  hostId: string;
  connectorId: string;
  deviceLabel: string | null;
}> {
  const fields = exactDataObject(value, [
    "requestId", "hostId", "connectorId", "deviceLabel",
  ]);
  return Object.freeze({
    requestId: identifier(fields.requestId),
    hostId: identifier(fields.hostId),
    connectorId: identifier(fields.connectorId),
    deviceLabel: fields.deviceLabel === null ? null : identifier(fields.deviceLabel),
  });
}

function parseRevokeInput(value: unknown): Readonly<{
  requestId: string;
  hostId: string;
  connectorId: string;
  grantId: string;
  reason: "user_revoked";
}> {
  const fields = exactDataObject(value, [
    "requestId", "hostId", "connectorId", "grantId", "reason",
  ]);
  if (fields.reason !== "user_revoked") return closed();
  return Object.freeze({
    requestId: identifier(fields.requestId),
    hostId: identifier(fields.hostId),
    connectorId: identifier(fields.connectorId),
    grantId: identifier(fields.grantId),
    reason: "user_revoked",
  });
}

function projectEnrollment(
  value: unknown,
  input: ReturnType<typeof parseCreateInput>,
): RelayV2DashboardManagementEnrollmentReceipt {
  const fields = exactDataObject(value, [
    "type",
    "requestId",
    "connectorGeneration",
    "connectorId",
    "hostId",
    "deduplicated",
    "enrollmentId",
    "enrollmentCode",
    "issuerUrl",
    "relayUrl",
    "expiresAtMs",
    "deviceLabel",
  ]);
  if (fields.type !== "enrollment.created"
    || fields.requestId !== input.requestId
    || fields.hostId !== input.hostId
    || fields.connectorId !== input.connectorId
    || !Number.isSafeInteger(fields.connectorGeneration)
    || (fields.connectorGeneration as number) <= 0
    || typeof fields.deduplicated !== "boolean"
    || fields.deviceLabel !== input.deviceLabel) return closed();
  return Object.freeze({
    enrollmentId: identifier(fields.enrollmentId),
    enrollmentCode: enrollmentCode(fields.enrollmentCode),
    expiresAtMs: timestamp(fields.expiresAtMs),
    issuerUrl: managementUrl(fields.issuerUrl, "https:", "/"),
    relayUrl: managementUrl(fields.relayUrl, "wss:", "/client"),
    hostId: input.hostId,
    connectorId: input.connectorId,
    deviceLabel: input.deviceLabel,
  });
}

function projectRevocation(
  value: unknown,
  input: ReturnType<typeof parseRevokeInput>,
): RelayV2DashboardManagementGrantRevocationReceipt {
  const fields = exactDataObject(value, [
    "type",
    "requestId",
    "connectorGeneration",
    "connectorId",
    "hostId",
    "grantId",
    "revokedAtMs",
    "alreadyRevoked",
  ]);
  if (fields.type !== "grant.revoked"
    || fields.requestId !== input.requestId
    || fields.hostId !== input.hostId
    || fields.connectorId !== input.connectorId
    || fields.grantId !== input.grantId
    || !Number.isSafeInteger(fields.connectorGeneration)
    || (fields.connectorGeneration as number) <= 0
    || typeof fields.alreadyRevoked !== "boolean") return closed();
  return Object.freeze({
    grantId: input.grantId,
    revokedAtMs: timestamp(fields.revokedAtMs),
    alreadyRevoked: fields.alreadyRevoked,
    hostId: input.hostId,
    connectorId: input.connectorId,
  });
}

function mapOwnerError(error: unknown): never {
  if (error instanceof RelayV2DashboardManagementAuthorityFailure) throw error;
  const ownerCode = hostCarrierControlErrorCode(error);
  if (ownerCode !== null) {
    switch (ownerCode) {
      case "NOT_REGISTERED":
        throw new RelayV2DashboardManagementAuthorityFailure("NOT_READY");
      case "BUSY":
      case "QUEUE_REFUSED":
        throw new RelayV2DashboardManagementAuthorityFailure("BUSY");
      case "CARRIER_UNAVAILABLE":
        throw new RelayV2DashboardManagementAuthorityFailure("UNAVAILABLE");
      case "CARRIER_REJECTED":
        throw new RelayV2DashboardManagementAuthorityFailure("OPERATION_FAILED");
    }
  }
  return closed();
}

function hostCarrierControlErrorCode(
  error: unknown,
): RelayV2HostCarrierDashboardManagementControlErrorCode | null {
  if (!(error instanceof Error)
    || error.name !== "RelayV2HostCarrierDashboardManagementControlError") return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
  switch (descriptor.value) {
    case "NOT_REGISTERED":
    case "BUSY":
    case "QUEUE_REFUSED":
    case "CARRIER_UNAVAILABLE":
    case "CARRIER_REJECTED":
      return descriptor.value;
    default:
      return null;
  }
}

/**
 * Unwired NDM4 projection over the only registered HostCarrier owner. It has
 * no sender, queue, request registry, retry, deadline, connector, or fallback.
 */
export class RelayV2DashboardManagementHostCarrierControlAdapter
implements RelayV2DashboardManagementCarrierControlPort {
  readonly #owner: RelayV2HostCarrierDashboardManagementControlOwner;
  #terminallyClosed = false;

  constructor(options: RelayV2DashboardManagementHostCarrierControlAdapterOptions) {
    const fields = exactDataObject(options, ["owner"]);
    const owner = fields.owner;
    let frozen: boolean;
    try {
      frozen = Object.isFrozen(owner);
    } catch {
      return closed();
    }
    if (!frozen || !RelayV2HostCarrierDashboardManagementControlOwner.isOwner(owner)) {
      return closed();
    }
    this.#owner = owner;
  }

  async createEnrollment(input: Readonly<{
    requestId: string;
    hostId: string;
    connectorId: string;
    deviceLabel: string | null;
  }>): Promise<RelayV2DashboardManagementEnrollmentReceipt> {
    this.ensureOpen();
    try {
      const parsed = parseCreateInput(input);
      return projectEnrollment(
        await this.#owner.invoke(Object.freeze({
          operation: "create_enrollment",
          input: parsed,
        })),
        parsed,
      );
    } catch (error) {
      return this.fail(error);
    }
  }

  async revokeGrant(input: Readonly<{
    requestId: string;
    hostId: string;
    connectorId: string;
    grantId: string;
    reason: "user_revoked";
  }>): Promise<RelayV2DashboardManagementGrantRevocationReceipt> {
    this.ensureOpen();
    try {
      const parsed = parseRevokeInput(input);
      return projectRevocation(
        await this.#owner.invoke(Object.freeze({
          operation: "revoke_grant",
          input: parsed,
        })),
        parsed,
      );
    } catch (error) {
      return this.fail(error);
    }
  }

  private ensureOpen(): void {
    if (this.#terminallyClosed) return closed();
  }

  private fail(error: unknown): never {
    if (error instanceof RelayV2DashboardManagementAuthorityFailure
      || hostCarrierControlErrorCode(error) !== null) {
      return mapOwnerError(error);
    }
    this.#terminallyClosed = true;
    return closed();
  }
}
