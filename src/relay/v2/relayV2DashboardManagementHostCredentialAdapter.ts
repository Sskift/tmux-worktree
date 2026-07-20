import {
  RelayV2DashboardManagementAuthorityFailure,
  type RelayV2DashboardManagementCredentialInspection,
  type RelayV2DashboardManagementCredentialPort,
} from "./relayV2DashboardManagementAuthority.js";
import type { RelayV2DashboardManagementProtocolV2ErrorCode } from "./relayV2DashboardManagementProtocolV2.js";
import {
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
  type RelayV2HostCredentialAuthorityErrorCode,
  type RelayV2HostCredentialExchangeCut,
} from "./hostCredentialAuthority.js";
import type {
  RelayV2HostCredentialOwnerBoundExchangePort,
} from "./hostCredentialExchangeCoordinator.js";
import {
  isRelayV2HostCredentialOwnerBoundExchangePort,
} from "./hostCredentialExchangeCoordinator.js";
import type { RelayV2HostCredentialHttpsAdapterErrorCode } from "./hostCredentialHttpsAdapter.js";
import { isRelayV2AuthIdentifier } from "./token.js";

const MAX_IDENTIFIER_BYTES = 128;
const MAX_COUNTER = 18_446_744_073_709_551_615n;

type DataRecord = Record<string, unknown>;

export interface RelayV2DashboardManagementHostCredentialAdapterOptions {
  readonly owner: RelayV2HostCredentialOwnerBoundExchangePort;
  readonly credentialReference: string;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  /** Non-sensitive resolver key for a new bootstrap attempt. */
  readonly bootstrapSecretReference: string;
  /** Non-sensitive resolver key for a new refresh attempt. */
  readonly refreshSecretReference: string;
  /** Caller-owned cancellation. This adapter never creates another deadline. */
  readonly signal: AbortSignal;
}

export class RelayV2DashboardManagementHostCredentialAdapterClosedError extends Error {
  constructor() {
    super("Relay v2 Dashboard host credential adapter closed");
    this.name = "RelayV2DashboardManagementHostCredentialAdapterClosedError";
  }
}

interface ParsedCredentialInspection {
  credentialVersion: string;
  hostId: string;
  principalId: string | null;
  grantId: string | null;
  accessJti: string | null;
  accessExpiresAtMs: number | null;
  refreshExpiresAtMs: number | null;
  pendingCredentialAttempt: ParsedPendingAttempt | null;
  pendingReauthentication: ParsedPendingReauthentication | null;
}

interface ParsedPendingAttempt {
  kind: "bootstrap" | "refresh";
  attemptId: string;
  oldCredentialVersion: string;
  oldSecretReference: string;
}

interface ParsedPendingReauthentication {
  credentialReference: string;
  credentialVersion: string;
  requestId: string;
  grantId: string;
  accessJti: string;
}

function closed(): never {
  throw new RelayV2DashboardManagementHostCredentialAdapterClosedError();
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

function ownData(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function capturedExchangeCut(value: unknown): RelayV2HostCredentialExchangeCut {
  if (!isObject(value)) return closed();
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "cut");
  } catch {
    return closed();
  }
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || !isObject(descriptor.value)) return closed();
  return descriptor.value as RelayV2HostCredentialExchangeCut;
}

function identifier(value: unknown): string {
  if (!isRelayV2AuthIdentifier(value)
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) return closed();
  return value;
}

function credentialReference(value: unknown): string {
  const reference = identifier(value);
  if (!reference.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || reference.length === RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length) {
    return closed();
  }
  return reference;
}

function counter(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return closed();
  }
  try {
    if (BigInt(value) > MAX_COUNTER) return closed();
  } catch {
    return closed();
  }
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return closed();
  return value as number;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function parsePendingAttempt(value: unknown): ParsedPendingAttempt | null {
  if (value === null) return null;
  const fields = exactDataObject(value, [
    "kind", "attemptId", "oldCredentialVersion", "oldSecretReference",
  ]);
  if (fields.kind !== "bootstrap" && fields.kind !== "refresh") return closed();
  return Object.freeze({
    kind: fields.kind,
    attemptId: identifier(fields.attemptId),
    oldCredentialVersion: counter(fields.oldCredentialVersion),
    oldSecretReference: identifier(fields.oldSecretReference),
  });
}

function parsePendingReauthentication(value: unknown): ParsedPendingReauthentication | null {
  if (value === null) return null;
  const fields = exactDataObject(value, [
    "credentialReference", "credentialVersion", "requestId", "grantId", "accessJti",
  ]);
  return Object.freeze({
    credentialReference: credentialReference(fields.credentialReference),
    credentialVersion: counter(fields.credentialVersion),
    requestId: identifier(fields.requestId),
    grantId: identifier(fields.grantId),
    accessJti: identifier(fields.accessJti),
  });
}

function parseInspection(value: unknown): ParsedCredentialInspection | null {
  if (value === null) return null;
  const fields = exactDataObject(value, [
    "credentialVersion",
    "hostId",
    "principalId",
    "grantId",
    "accessJti",
    "accessExpiresAtMs",
    "refreshExpiresAtMs",
    "pendingCredentialAttempt",
    "pendingReauthentication",
  ]);
  const parsed = Object.freeze({
    credentialVersion: counter(fields.credentialVersion),
    hostId: identifier(fields.hostId),
    principalId: nullableIdentifier(fields.principalId),
    grantId: nullableIdentifier(fields.grantId),
    accessJti: nullableIdentifier(fields.accessJti),
    accessExpiresAtMs: fields.accessExpiresAtMs === null
      ? null
      : timestamp(fields.accessExpiresAtMs),
    refreshExpiresAtMs: fields.refreshExpiresAtMs === null
      ? null
      : timestamp(fields.refreshExpiresAtMs),
    pendingCredentialAttempt: parsePendingAttempt(fields.pendingCredentialAttempt),
    pendingReauthentication: parsePendingReauthentication(fields.pendingReauthentication),
  });
  const absent = parsed.principalId === null
    && parsed.grantId === null
    && parsed.accessJti === null
    && parsed.accessExpiresAtMs === null
    && parsed.refreshExpiresAtMs === null;
  const complete = parsed.principalId !== null
    && parsed.grantId !== null
    && parsed.accessJti !== null
    && parsed.accessExpiresAtMs !== null
    && parsed.refreshExpiresAtMs !== null;
  if ((!absent && !complete)
    || (parsed.credentialVersion === "0") !== absent
    || (absent && (parsed.pendingCredentialAttempt?.kind !== "bootstrap"
      || parsed.pendingCredentialAttempt.oldCredentialVersion !== "0"
      || parsed.pendingReauthentication !== null))
    || (complete && parsed.pendingCredentialAttempt?.kind === "bootstrap")
    || (parsed.pendingCredentialAttempt !== null
      && parsed.pendingCredentialAttempt.oldCredentialVersion !== parsed.credentialVersion)
    || (parsed.pendingReauthentication !== null
      && (parsed.pendingReauthentication.credentialVersion === "0"
        || parsed.grantId !== parsed.pendingReauthentication.grantId
        || BigInt(parsed.pendingReauthentication.credentialVersion)
          > BigInt(parsed.credentialVersion)
        || (parsed.pendingReauthentication.credentialVersion === parsed.credentialVersion
          && parsed.accessJti !== parsed.pendingReauthentication.accessJti)))) return closed();
  return parsed;
}

function requestId(value: unknown): string {
  const fields = exactDataObject(value, ["requestId"]);
  return identifier(fields.requestId);
}

function operationFailure(code: RelayV2DashboardManagementProtocolV2ErrorCode): never {
  throw new RelayV2DashboardManagementAuthorityFailure(code);
}

function authorityErrorCode(error: unknown): RelayV2HostCredentialAuthorityErrorCode | null {
  if (ownData(error, "name") !== "RelayV2HostCredentialAuthorityError") return null;
  const code = ownData(error, "code");
  switch (code) {
    case "RELAY_V2_HOST_CREDENTIAL_STATE_INVALID":
    case "RELAY_V2_HOST_CREDENTIAL_NOT_FOUND":
    case "RELAY_V2_HOST_CREDENTIAL_NOT_READY":
    case "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT":
    case "RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT":
    case "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN":
    case "RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE":
    case "RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE":
    case "RELAY_V2_HOST_CREDENTIAL_VERSION_EXHAUSTED":
      return code;
    default:
      return null;
  }
}

function httpsErrorCode(error: unknown): RelayV2HostCredentialHttpsAdapterErrorCode | null {
  if (ownData(error, "name") !== "RelayV2HostCredentialHttpsAdapterError") return null;
  const code = ownData(error, "code");
  switch (code) {
    case "CONFIGURATION_INVALID":
    case "REQUEST_INVALID":
    case "CREDENTIAL_REJECTED":
    case "EXCHANGE_FAILED":
    case "ABORTED":
      return code;
    default:
      return null;
  }
}

function mapOperationError(error: unknown): never {
  const authorityCode = authorityErrorCode(error);
  switch (authorityCode) {
    case "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT":
    case "RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT":
      return operationFailure("BUSY");
    case "RELAY_V2_HOST_CREDENTIAL_NOT_FOUND":
    case "RELAY_V2_HOST_CREDENTIAL_NOT_READY":
      return operationFailure("NOT_READY");
    case "RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE":
    case "RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE":
      return operationFailure("UNAVAILABLE");
    case "RELAY_V2_HOST_CREDENTIAL_STATE_INVALID":
    case "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN":
    case "RELAY_V2_HOST_CREDENTIAL_VERSION_EXHAUSTED":
      return operationFailure("OPERATION_FAILED");
  }
  const httpsCode = httpsErrorCode(error);
  if (httpsCode === "EXCHANGE_FAILED") return operationFailure("UNAVAILABLE");
  if (httpsCode === "CREDENTIAL_REJECTED") {
    return operationFailure(ownData(error, "retryable") === true ? "BUSY" : "OPERATION_FAILED");
  }
  if (httpsCode === "CONFIGURATION_INVALID"
    || httpsCode === "REQUEST_INVALID"
    || httpsCode === "ABORTED") return operationFailure("OPERATION_FAILED");
  return closed();
}

function validateCommit(value: unknown, oldCredentialVersion: string): void {
  const fields = exactDataObject(value, ["status", "credentialVersion"]);
  if (fields.status === "stale") {
    if (fields.credentialVersion !== null) counter(fields.credentialVersion);
    return operationFailure("OPERATION_FAILED");
  }
  if (fields.status !== "applied") return closed();
  const appliedVersion = counter(fields.credentialVersion);
  if (BigInt(oldCredentialVersion) >= MAX_COUNTER
    || appliedVersion !== (BigInt(oldCredentialVersion) + 1n).toString()) return closed();
}

/**
 * Unwired projection/orchestration adapter for the NDM1 credential port.
 * Durable credential, attempt, CAS, secret, and exchange facts remain in the
 * owner-bound authority/coordinator composition. This adapter retains none of them and never
 * retries, repairs, starts a second protocol, or creates a second deadline.
 */
export class RelayV2DashboardManagementHostCredentialAdapter
implements RelayV2DashboardManagementCredentialPort {
  private readonly owner: RelayV2HostCredentialOwnerBoundExchangePort;
  private readonly credentialReference: string;
  private readonly hostId: string;
  private readonly hostEpoch: string;
  private readonly hostInstanceId: string;
  private readonly bootstrapSecretReference: string;
  private readonly refreshSecretReference: string;
  private readonly signal: AbortSignal;

  constructor(options: RelayV2DashboardManagementHostCredentialAdapterOptions) {
    const fields = exactDataObject(options, [
      "owner",
      "credentialReference",
      "hostId",
      "hostEpoch",
      "hostInstanceId",
      "bootstrapSecretReference",
      "refreshSecretReference",
      "signal",
    ]);
    if (!isRelayV2HostCredentialOwnerBoundExchangePort(fields.owner)
      || !(fields.signal instanceof AbortSignal)) return closed();
    this.owner = fields.owner;
    this.credentialReference = credentialReference(fields.credentialReference);
    this.hostId = identifier(fields.hostId);
    this.hostEpoch = identifier(fields.hostEpoch);
    this.hostInstanceId = identifier(fields.hostInstanceId);
    this.bootstrapSecretReference = identifier(fields.bootstrapSecretReference);
    this.refreshSecretReference = identifier(fields.refreshSecretReference);
    this.signal = fields.signal;
  }

  inspect(): RelayV2DashboardManagementCredentialInspection {
    let inspection: ParsedCredentialInspection | null;
    try {
      inspection = parseInspection(this.owner.inspect(this.credentialReference));
    } catch (error) {
      const code = authorityErrorCode(error);
      if (code === "RELAY_V2_HOST_CREDENTIAL_NOT_FOUND") {
        return Object.freeze({ status: "missing" });
      }
      if (code === "RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE"
        || code === "RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT") {
        return Object.freeze({ status: "failed", retryable: true });
      }
      if (code !== null) return Object.freeze({ status: "failed", retryable: false });
      return closed();
    }
    if (inspection === null) return Object.freeze({ status: "missing" });
    if (inspection.hostId !== this.hostId
      || (inspection.pendingReauthentication !== null
        && inspection.pendingReauthentication.credentialReference
          !== this.credentialReference)) return closed();
    if (inspection.credentialVersion === "0") {
      return Object.freeze({ status: "missing" });
    }
    if (inspection.accessExpiresAtMs === null) return closed();
    return Object.freeze({
      status: "ready",
      hostId: inspection.hostId,
      credentialReference: this.credentialReference,
      expiresAtMs: inspection.accessExpiresAtMs,
    });
  }

  async bootstrap(input: Readonly<{ requestId: string }>): Promise<void> {
    const requestedAttemptId = requestId(input);
    let cut: RelayV2HostCredentialExchangeCut | null = null;
    try {
      const capturedValue = this.owner.capture({
        credentialReference: this.credentialReference,
        hostId: this.hostId,
      });
      cut = capturedExchangeCut(capturedValue);
      const captured = exactDataObject(capturedValue, ["inspection", "cut"]);
      if (captured.cut !== cut) return closed();
      const inspection = parseInspection(captured.inspection);
      if (inspection !== null && (inspection.hostId !== this.hostId
        || (inspection.pendingReauthentication !== null
          && inspection.pendingReauthentication.credentialReference
            !== this.credentialReference))) {
        return operationFailure("BUSY");
      }
      const pending = inspection?.pendingCredentialAttempt ?? null;
      if (pending !== null && pending.kind !== "bootstrap") {
        return operationFailure("BUSY");
      }
      if (inspection !== null && inspection.credentialVersion !== "0") {
        return operationFailure("NOT_READY");
      }
      const attemptId = pending?.attemptId ?? requestedAttemptId;
      const oldSecretReference = pending?.oldSecretReference
        ?? this.bootstrapSecretReference;
      const commit = await this.owner.bootstrap(cut, {
        credentialReference: this.credentialReference,
        hostId: this.hostId,
        attemptId,
        oldSecretReference,
        hostEpoch: this.hostEpoch,
        hostInstanceId: this.hostInstanceId,
      }, this.signal);
      validateCommit(commit, pending?.oldCredentialVersion ?? "0");
    } catch (error) {
      if (error instanceof RelayV2DashboardManagementAuthorityFailure
        || error instanceof RelayV2DashboardManagementHostCredentialAdapterClosedError) throw error;
      return mapOperationError(error);
    } finally {
      if (cut !== null) this.owner.release(cut);
    }
  }

  async refresh(input: Readonly<{ requestId: string }>): Promise<void> {
    const requestedAttemptId = requestId(input);
    let cut: RelayV2HostCredentialExchangeCut | null = null;
    try {
      const capturedValue = this.owner.capture({
        credentialReference: this.credentialReference,
        hostId: this.hostId,
      });
      cut = capturedExchangeCut(capturedValue);
      const captured = exactDataObject(capturedValue, ["inspection", "cut"]);
      if (captured.cut !== cut) return closed();
      const inspection = parseInspection(captured.inspection);
      if (inspection !== null && (inspection.hostId !== this.hostId
        || (inspection.pendingReauthentication !== null
          && inspection.pendingReauthentication.credentialReference
            !== this.credentialReference))) {
        return operationFailure("BUSY");
      }
      const pending = inspection?.pendingCredentialAttempt ?? null;
      if (pending !== null && pending.kind !== "refresh") {
        return operationFailure("BUSY");
      }
      if (inspection === null || inspection.credentialVersion === "0") {
        return operationFailure("NOT_READY");
      }
      const attemptId = pending?.attemptId ?? requestedAttemptId;
      const oldSecretReference = pending?.oldSecretReference
        ?? this.refreshSecretReference;
      const commit = await this.owner.refresh(cut, {
        credentialReference: this.credentialReference,
        attemptId,
        oldSecretReference,
        hostInstanceId: this.hostInstanceId,
      }, this.signal);
      validateCommit(commit, pending?.oldCredentialVersion ?? inspection.credentialVersion);
    } catch (error) {
      if (error instanceof RelayV2DashboardManagementAuthorityFailure
        || error instanceof RelayV2DashboardManagementHostCredentialAdapterClosedError) throw error;
      return mapOperationError(error);
    } finally {
      if (cut !== null) this.owner.release(cut);
    }
  }
}
