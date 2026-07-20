import type {
  RelayV2HostCarrierCredentialReferences,
  RelayV2HostCredentialAckFence,
  RelayV2HostCredentialRecord,
} from "./hostCarrier.js";
import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import {
  decodeCanonicalRelayV2Base64Url,
  isRelayV2AuthIdentifier,
  RELAY_V2_ACCESS_TOKEN_AUDIENCE,
  RELAY_V2_MAX_ACCESS_TTL_SECONDS,
  type RelayV2AccessTokenClaims,
} from "./token.js";

export const RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE =
  "relay-v2-host-credential-ref:" as const;

const MAX_COUNTER = 18_446_744_073_709_551_615n;
const MAX_TOKEN_BYTES = 8_192;
const MAX_ACCESS_PAYLOAD_BYTES = 4_096;
const MAX_ACCESS_MAC_BYTES = 32;
const MAX_CAS_CONFLICTS = 4;

type JsonObject = Record<string, unknown>;

/** Opaque to the authority; only the storage implementation may interpret it. */
export type RelayV2HostCredentialStorageRevision = unknown;

export interface RelayV2HostCredentialStorageRead {
  state: unknown | null;
  revision: RelayV2HostCredentialStorageRevision;
}

export type RelayV2HostCredentialStorageCasResult =
  | { status: "swapped" }
  | { status: "conflict"; current: RelayV2HostCredentialStorageRead }
  | { status: "uncertain" };

export interface RelayV2HostCredentialStorageTransaction {
  /** Returns a defensive state value and an opaque revision from one durable cut. */
  read(): RelayV2HostCredentialStorageRead;
  /**
   * `swapped` means the replacement durably linearized before return.
   * `uncertain` never authorizes retry inside the same operation.
   */
  compareAndSwap(
    expected: RelayV2HostCredentialStorageRevision,
    replacement: RelayV2HostCredentialState,
  ): RelayV2HostCredentialStorageCasResult;
}

export interface RelayV2HostCredentialStorage {
  runExclusive<T>(
    reference: string,
    operation: (transaction: RelayV2HostCredentialStorageTransaction) => T,
  ): T;
}

/** A credential secret source keyed only by a non-sensitive opaque reference. */
export interface RelayV2HostCredentialSecretResolver {
  resolve(reference: string): string;
}

export type RelayV2HostCredentialAttemptKind = "bootstrap" | "refresh";

export interface RelayV2HostPendingCredentialAttempt {
  kind: RelayV2HostCredentialAttemptKind;
  attemptId: string;
  oldCredentialVersion: string;
  oldSecretReference: string;
}

export interface RelayV2HostPendingReauthentication {
  credentialReference: string;
  credentialVersion: string;
  requestId: string;
  grantId: string;
  accessJti: string;
}

/**
 * The complete business state owned by this authority. Storage implementations
 * may encode it however their separately frozen contract permits; this module
 * does not own a filesystem, keychain, lock, path, or serialization schema.
 */
export interface RelayV2HostCredentialState {
  credentialVersion: string;
  hostId: string;
  principalId: string | null;
  grantId: string | null;
  accessToken: string | null;
  accessExpiresAtMs: number | null;
  refreshToken: string | null;
  refreshExpiresAtMs: number | null;
  accessJti: string | null;
  pendingCredentialAttempt: RelayV2HostPendingCredentialAttempt | null;
  pendingReauthentication: RelayV2HostPendingReauthentication | null;
}

export interface RelayV2HostCredentialAttemptFence {
  credentialReference: string;
  kind: RelayV2HostCredentialAttemptKind;
  attemptId: string;
  oldCredentialVersion: string;
  oldSecretReference: string;
}

export interface RelayV2HostBootstrapPreparation {
  credentialReference: string;
  hostId: string;
  attemptId: string;
  oldSecretReference: string;
}

export interface RelayV2HostBootstrapCredentialMaterial {
  bootstrapToken: string;
  hostId: string;
}

export interface RelayV2HostPreparedBootstrap {
  fence: RelayV2HostCredentialAttemptFence;
  credential: RelayV2HostBootstrapCredentialMaterial;
}

export interface RelayV2HostBootstrapResponse {
  bootstrapAttemptId: string;
  principalId: string;
  grantId: string;
  hostId: string;
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

export interface RelayV2HostRefreshPreparation {
  credentialReference: string;
  attemptId: string;
  oldSecretReference: string;
}

export interface RelayV2HostRefreshCredentialMaterial {
  grantId: string;
  refreshToken: string;
}

export interface RelayV2HostPreparedRefresh {
  fence: RelayV2HostCredentialAttemptFence;
  credential: RelayV2HostRefreshCredentialMaterial;
}

export interface RelayV2HostRefreshResponse {
  refreshAttemptId: string;
  principalId: string;
  grantId: string;
  hostId: string;
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

export interface RelayV2HostReauthenticationPreparation {
  credentialReference: string;
  requestId: string;
}

export interface RelayV2HostPreparedReauthentication {
  fence: RelayV2HostCredentialAckFence;
  accessToken: string;
}

export type RelayV2HostCredentialResponseCommit =
  | { status: "applied"; credentialVersion: string }
  | { status: "stale"; credentialVersion: string | null };

export interface RelayV2HostCredentialInspection {
  credentialVersion: string;
  hostId: string;
  principalId: string | null;
  grantId: string | null;
  accessJti: string | null;
  accessExpiresAtMs: number | null;
  refreshExpiresAtMs: number | null;
  pendingCredentialAttempt: RelayV2HostPendingCredentialAttempt | null;
  pendingReauthentication: RelayV2HostPendingReauthentication | null;
}

declare const RELAY_V2_HOST_CREDENTIAL_EXCHANGE_CUT: unique symbol;

/**
 * Opaque, process-local, one-shot authority cut. Only the issuing authority may
 * consume it; the value carries no credential or secret material.
 */
export interface RelayV2HostCredentialExchangeCut {
  readonly [RELAY_V2_HOST_CREDENTIAL_EXCHANGE_CUT]: never;
}

export interface RelayV2HostCredentialExchangeCutInput {
  credentialReference: string;
  hostId: string;
}

export interface RelayV2HostCredentialCapturedExchangeCut {
  inspection: RelayV2HostCredentialInspection | null;
  cut: RelayV2HostCredentialExchangeCut;
}

declare const RELAY_V2_HOST_CREDENTIAL_EXCHANGE_LEASE: unique symbol;

export interface RelayV2HostCredentialExchangeLease {
  readonly [RELAY_V2_HOST_CREDENTIAL_EXCHANGE_LEASE]: never;
}

declare const RELAY_V2_HOST_CREDENTIAL_CONNECTION_ADMISSION: unique symbol;

/**
 * Process-local, owner-bound connection cut. It deliberately has no runtime
 * fields: the exact credential material remains inside this authority.
 */
export interface RelayV2HostCredentialConnectionAdmission {
  readonly [RELAY_V2_HOST_CREDENTIAL_CONNECTION_ADMISSION]: never;
}

declare const RELAY_V2_HOST_CREDENTIAL_CONNECTION_TRANSPORT_OWNER: unique symbol;

/** Opaque transport-lifecycle owner retained only by the WSS factory. */
export interface RelayV2HostCredentialConnectionTransportOwner {
  readonly [RELAY_V2_HOST_CREDENTIAL_CONNECTION_TRANSPORT_OWNER]: never;
}

declare const RELAY_V2_HOST_CREDENTIAL_CONNECTION_AUTHORIZATION: unique symbol;

/** One-shot secretless capability retained only until request finalization. */
export interface RelayV2HostCredentialConnectionAuthorization {
  readonly [RELAY_V2_HOST_CREDENTIAL_CONNECTION_AUTHORIZATION]: never;
}

export interface RelayV2HostCredentialConnectionRequestFinalizationPort {
  /** The lifecycle writes this value directly to the captured request and ends it. */
  readonly finalize: (authorizationValue: string) => void;
}

export interface RelayV2HostCredentialConnectionAttemptBinding {
  readonly requestId: string;
  readonly controllerGeneration: string;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
}

export interface RelayV2HostCredentialConnectionCarrierBinding {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
}

export interface RelayV2HostCredentialConnectionMetadata {
  readonly reference: string;
  readonly version: string;
  readonly grantId: string;
  readonly accessJti: string;
}

export interface RelayV2HostPreparedBootstrapFromCut {
  prepared: RelayV2HostPreparedBootstrap;
  lease: RelayV2HostCredentialExchangeLease;
}

export interface RelayV2HostPreparedRefreshFromCut {
  prepared: RelayV2HostPreparedRefresh;
  lease: RelayV2HostCredentialExchangeLease;
}

export type RelayV2HostCredentialAuthorityErrorCode =
  | "RELAY_V2_HOST_CREDENTIAL_STATE_INVALID"
  | "RELAY_V2_HOST_CREDENTIAL_NOT_FOUND"
  | "RELAY_V2_HOST_CREDENTIAL_NOT_READY"
  | "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT"
  | "RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT"
  | "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN"
  | "RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE"
  | "RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE"
  | "RELAY_V2_HOST_CREDENTIAL_VERSION_EXHAUSTED";

export class RelayV2HostCredentialAuthorityError extends Error {
  constructor(readonly code: RelayV2HostCredentialAuthorityErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2HostCredentialAuthorityError";
  }
}

export interface RelayV2HostCredentialAuthorityOptions {
  storage: RelayV2HostCredentialStorage;
  secretResolver: RelayV2HostCredentialSecretResolver;
}

type Transition<T> =
  | { kind: "unchanged"; value: T }
  | { kind: "replace"; value: T; replacement: RelayV2HostCredentialState };

interface RelayV2HostCredentialExchangeCutBinding {
  credentialReference: string;
  hostId: string;
  statePresent: boolean;
  oldCredentialVersion: string;
  pendingCredentialAttempt: RelayV2HostPendingCredentialAttempt | null;
}

interface RelayV2HostCredentialExchangeCutRecord {
  owner: RelayV2HostCredentialAuthority;
  cut: RelayV2HostCredentialExchangeCut;
  group: RelayV2HostCredentialExchangeCutGroup;
  phase: "issued" | "consumed" | "released";
  consumer: object | null;
}

interface RelayV2HostCredentialExchangeCutGroup {
  owner: RelayV2HostCredentialAuthority;
  binding: RelayV2HostCredentialExchangeCutBinding;
  phase: "issued" | "consumed" | "released";
  candidate: RelayV2HostCredentialExchangeCutRecord | null;
  winner: RelayV2HostCredentialExchangeCutRecord | null;
  members: Set<RelayV2HostCredentialExchangeCutRecord>;
}

interface RelayV2HostCredentialExchangeCutConsumption {
  cut: RelayV2HostCredentialExchangeCut;
  consumer: object;
}

interface RelayV2HostCredentialExchangeLeaseRecord {
  owner: RelayV2HostCredentialAuthority;
  lease: RelayV2HostCredentialExchangeLease;
  cutRecord: RelayV2HostCredentialExchangeCutRecord;
  consumer: object;
  released: boolean;
}

interface RelayV2HostCredentialConnectionCut {
  readonly reference: string;
  readonly version: string;
  readonly hostId: string;
  readonly grantId: string;
  readonly accessJti: string;
  readonly accessExpiresAtMs: number;
}

interface RelayV2HostCredentialConnectionAdmissionRecord {
  readonly owner: RelayV2HostCredentialAuthority;
  readonly transportOwner: RelayV2HostCredentialConnectionTransportOwner;
  readonly binding: RelayV2HostCredentialConnectionAttemptBinding;
  readonly cut: RelayV2HostCredentialConnectionCut;
  carrierConsumed: boolean;
  phase: "issued" | "released";
}

interface RelayV2HostCredentialConnectionTransportOwnerRecord {
  readonly owner: RelayV2HostCredentialAuthority;
}

interface RelayV2HostCredentialConnectionAuthorizationRecord {
  readonly owner: RelayV2HostCredentialAuthority;
  readonly transportOwner: RelayV2HostCredentialConnectionTransportOwner;
  readonly cut: RelayV2HostCredentialConnectionCut;
}

const hostCredentialAuthorities = new WeakSet<object>();
const hostCredentialExchangeCuts = new WeakMap<object, RelayV2HostCredentialExchangeCutRecord>();
const hostCredentialExchangeLeases = new WeakMap<
object,
RelayV2HostCredentialExchangeLeaseRecord
>();
const hostCredentialConnectionAdmissions = new WeakMap<
object,
RelayV2HostCredentialConnectionAdmissionRecord
>();
const hostCredentialConnectionSecrets = new WeakMap<object, string>();
const hostCredentialConnectionTransportOwners = new WeakMap<
object,
RelayV2HostCredentialConnectionTransportOwnerRecord
>();
const hostCredentialConnectionAuthorizations = new WeakMap<
object,
RelayV2HostCredentialConnectionAuthorizationRecord
>();
const hostCredentialConnectionAuthorizationSecrets = new WeakMap<object, string>();
const connectionAdmissionAuthorityKey = Object.freeze({});

export function isRelayV2HostCredentialAuthority(
  value: unknown,
): value is RelayV2HostCredentialAuthority {
  return typeof value === "object"
    && value !== null
    && hostCredentialAuthorities.has(value);
}

function messageForCode(code: RelayV2HostCredentialAuthorityErrorCode): string {
  switch (code) {
    case "RELAY_V2_HOST_CREDENTIAL_STATE_INVALID":
      return "Relay v2 host credential authority state is invalid";
    case "RELAY_V2_HOST_CREDENTIAL_NOT_FOUND":
      return "Relay v2 host credential does not exist";
    case "RELAY_V2_HOST_CREDENTIAL_NOT_READY":
      return "Relay v2 host credential is not ready";
    case "RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT":
      return "Relay v2 host credential attempt conflicts with authority state";
    case "RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT":
      return "Relay v2 host credential authority could not settle bounded CAS conflicts";
    case "RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN":
      return "Relay v2 host credential authority commit is uncertain";
    case "RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE":
      return "Relay v2 host credential storage is unavailable";
    case "RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE":
      return "Relay v2 host credential secret is unavailable";
    case "RELAY_V2_HOST_CREDENTIAL_VERSION_EXHAUSTED":
      return "Relay v2 host credential version is exhausted";
  }
}

function fail(code: RelayV2HostCredentialAuthorityErrorCode): never {
  throw new RelayV2HostCredentialAuthorityError(code);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, fields: readonly string[]): boolean {
  const expected = new Set(fields);
  return fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => expected.has(field));
}

function isCanonicalCounter(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_COUNTER;
  } catch {
    return false;
  }
}

function nextCredentialVersion(value: string): string {
  const current = BigInt(value);
  if (current >= MAX_COUNTER) {
    return fail("RELAY_V2_HOST_CREDENTIAL_VERSION_EXHAUSTED");
  }
  return (current + 1n).toString();
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCredentialReference(value: unknown): value is string {
  if (typeof value !== "string"
    || !value.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || Buffer.byteLength(value, "utf8") > 128) return false;
  const identifier = value.slice(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(identifier);
}

function isSecretReference(value: unknown): value is string {
  return isRelayV2AuthIdentifier(value)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(value);
}

function isVisibleToken(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

function parseHostAccessToken(value: unknown): RelayV2AccessTokenClaims {
  try {
    if (!isVisibleToken(value, "twcap2.")) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    const segments = value.split(".");
    if (segments.length !== 3 || segments[0] !== "twcap2") {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    const payload = decodeCanonicalRelayV2Base64Url(segments[1], MAX_ACCESS_PAYLOAD_BYTES);
    const mac = decodeCanonicalRelayV2Base64Url(segments[2], MAX_ACCESS_MAC_BYTES);
    if (mac.byteLength !== MAX_ACCESS_MAC_BYTES) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    const parsed = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(payload), {
      maxDepth: 2,
      maxKeys: 14,
      maxNodes: 15,
    });
    const fields = [
      "v", "iss", "aud", "kid", "tokenUse", "role", "hostId",
      "principalId", "grantId", "iat", "nbf", "exp", "jti",
    ];
    if (!isRecord(parsed)
      || !hasExactKeys(parsed, fields)
      || parsed.v !== 2
      || parsed.aud !== RELAY_V2_ACCESS_TOKEN_AUDIENCE
      || parsed.tokenUse !== "access"
      || parsed.role !== "host") {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    for (const field of ["iss", "aud", "kid", "hostId", "principalId", "grantId", "jti"]) {
      if (!isRelayV2AuthIdentifier(parsed[field])) {
        return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
      }
    }
    if (!isTimestamp(parsed.iat)
      || !isTimestamp(parsed.nbf)
      || !isTimestamp(parsed.exp)
      || parsed.iat >= parsed.exp
      || parsed.nbf >= parsed.exp
      || parsed.exp - parsed.iat > RELAY_V2_MAX_ACCESS_TTL_SECONDS
      || !Number.isSafeInteger(parsed.exp * 1_000)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    return parsed as unknown as RelayV2AccessTokenClaims;
  } catch (error) {
    if (error instanceof RelayV2HostCredentialAuthorityError) throw error;
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
}

function parseCredentialAttempt(value: unknown): RelayV2HostPendingCredentialAttempt | null {
  if (value === null) return null;
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "kind", "attemptId", "oldCredentialVersion", "oldSecretReference",
    ])
    || (value.kind !== "bootstrap" && value.kind !== "refresh")
    || !isRelayV2AuthIdentifier(value.attemptId)
    || !isCanonicalCounter(value.oldCredentialVersion)
    || !isSecretReference(value.oldSecretReference)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
  return {
    kind: value.kind,
    attemptId: value.attemptId,
    oldCredentialVersion: value.oldCredentialVersion,
    oldSecretReference: value.oldSecretReference,
  };
}

function parsePendingReauthentication(
  value: unknown,
): RelayV2HostPendingReauthentication | null {
  if (value === null) return null;
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "credentialReference", "credentialVersion", "requestId", "grantId", "accessJti",
    ])
    || !isCredentialReference(value.credentialReference)
    || !isCanonicalCounter(value.credentialVersion)
    || value.credentialVersion === "0"
    || !isRelayV2AuthIdentifier(value.requestId)
    || !isRelayV2AuthIdentifier(value.grantId)
    || !isRelayV2AuthIdentifier(value.accessJti)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
  return {
    credentialReference: value.credentialReference,
    credentialVersion: value.credentialVersion,
    requestId: value.requestId,
    grantId: value.grantId,
    accessJti: value.accessJti,
  };
}

function parseState(
  value: unknown,
  credentialReference: string,
): RelayV2HostCredentialState {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "credentialVersion", "hostId", "principalId", "grantId", "accessToken",
      "accessExpiresAtMs", "refreshToken", "refreshExpiresAtMs", "accessJti",
      "pendingCredentialAttempt", "pendingReauthentication",
    ])
    || !isCanonicalCounter(value.credentialVersion)
    || !isRelayV2AuthIdentifier(value.hostId)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
  const pendingCredentialAttempt = parseCredentialAttempt(value.pendingCredentialAttempt);
  const pendingReauthentication = parsePendingReauthentication(value.pendingReauthentication);
  const material = [
    value.principalId,
    value.grantId,
    value.accessToken,
    value.accessExpiresAtMs,
    value.refreshToken,
    value.refreshExpiresAtMs,
    value.accessJti,
  ];
  const absent = material.every((field) => field === null);
  const complete = material.every((field) => field !== null);
  if (!absent && !complete) return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");

  if (absent) {
    if (value.credentialVersion !== "0"
      || pendingCredentialAttempt?.kind !== "bootstrap"
      || pendingCredentialAttempt.oldCredentialVersion !== "0"
      || pendingReauthentication !== null) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
  } else {
    if (value.credentialVersion === "0"
      || !isRelayV2AuthIdentifier(value.principalId)
      || !isRelayV2AuthIdentifier(value.grantId)
      || !isVisibleToken(value.refreshToken, "twref2.")
      || !isTimestamp(value.accessExpiresAtMs)
      || !isTimestamp(value.refreshExpiresAtMs)
      || !isRelayV2AuthIdentifier(value.accessJti)
      || pendingCredentialAttempt?.kind === "bootstrap") {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    const claims = parseHostAccessToken(value.accessToken);
    if (claims.hostId !== value.hostId
      || claims.principalId !== value.principalId
      || claims.grantId !== value.grantId
      || claims.jti !== value.accessJti
      || claims.exp * 1_000 !== value.accessExpiresAtMs
      || (pendingCredentialAttempt?.kind === "refresh"
        && pendingCredentialAttempt.oldCredentialVersion !== value.credentialVersion)
      || (pendingReauthentication !== null
        && (pendingReauthentication.credentialReference !== credentialReference
          || pendingReauthentication.grantId !== value.grantId
          || BigInt(pendingReauthentication.credentialVersion) > BigInt(value.credentialVersion)
          || (pendingReauthentication.credentialVersion === value.credentialVersion
            && pendingReauthentication.accessJti !== value.accessJti)))) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
  }
  return {
    credentialVersion: value.credentialVersion,
    hostId: value.hostId,
    principalId: value.principalId as string | null,
    grantId: value.grantId as string | null,
    accessToken: value.accessToken as string | null,
    accessExpiresAtMs: value.accessExpiresAtMs as number | null,
    refreshToken: value.refreshToken as string | null,
    refreshExpiresAtMs: value.refreshExpiresAtMs as number | null,
    accessJti: value.accessJti as string | null,
    pendingCredentialAttempt,
    pendingReauthentication,
  };
}

/**
 * Canonical strict defensive decoder for the authority's complete durable
 * state. It is pure and maps every malformed input to the authority's
 * redacted state-invalid error.
 */
export function decodeRelayV2HostCredentialState(
  value: unknown,
  credentialReference: string,
): RelayV2HostCredentialState {
  try {
    if (!isCredentialReference(credentialReference)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
    }
    return parseState(value, credentialReference);
  } catch {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
}

function validateReference(value: unknown): string {
  if (!isCredentialReference(value)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
  }
  return value;
}

function validateAttemptInput(
  value: RelayV2HostBootstrapPreparation | RelayV2HostRefreshPreparation,
): void {
  if (!isRecord(value)
    || !isCredentialReference(value.credentialReference)
    || !isRelayV2AuthIdentifier(value.attemptId)
    || !isSecretReference(value.oldSecretReference)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
  }
}

function validateBootstrapResponse(
  value: RelayV2HostBootstrapResponse,
): RelayV2AccessTokenClaims {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "bootstrapAttemptId", "principalId", "grantId", "hostId", "accessToken",
      "accessExpiresAtMs", "refreshToken", "refreshExpiresAtMs",
    ])
    || !isRelayV2AuthIdentifier(value.bootstrapAttemptId)
    || !isRelayV2AuthIdentifier(value.principalId)
    || !isRelayV2AuthIdentifier(value.grantId)
    || !isRelayV2AuthIdentifier(value.hostId)
    || !isTimestamp(value.accessExpiresAtMs)
    || !isVisibleToken(value.refreshToken, "twref2.")
    || !isTimestamp(value.refreshExpiresAtMs)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
  return parseHostAccessToken(value.accessToken);
}

function validateRefreshResponse(
  value: RelayV2HostRefreshResponse,
): RelayV2AccessTokenClaims {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "refreshAttemptId", "principalId", "grantId", "hostId", "accessToken",
      "accessExpiresAtMs", "refreshToken", "refreshExpiresAtMs",
    ])
    || !isRelayV2AuthIdentifier(value.refreshAttemptId)
    || !isRelayV2AuthIdentifier(value.principalId)
    || !isRelayV2AuthIdentifier(value.grantId)
    || !isRelayV2AuthIdentifier(value.hostId)
    || !isTimestamp(value.accessExpiresAtMs)
    || !isVisibleToken(value.refreshToken, "twref2.")
    || !isTimestamp(value.refreshExpiresAtMs)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
  }
  return parseHostAccessToken(value.accessToken);
}

function fenceMatches(
  pending: RelayV2HostPendingCredentialAttempt | null,
  fence: RelayV2HostCredentialAttemptFence,
  kind: RelayV2HostCredentialAttemptKind,
): pending is RelayV2HostPendingCredentialAttempt {
  return pending !== null
    && fence.kind === kind
    && pending.kind === kind
    && pending.attemptId === fence.attemptId
    && pending.oldCredentialVersion === fence.oldCredentialVersion
    && pending.oldSecretReference === fence.oldSecretReference;
}

function copyCredentialAttempt(
  value: RelayV2HostPendingCredentialAttempt | null,
): RelayV2HostPendingCredentialAttempt | null {
  return value ? { ...value } : null;
}

function copyPendingReauthentication(
  value: RelayV2HostPendingReauthentication | null,
): RelayV2HostPendingReauthentication | null {
  return value ? { ...value } : null;
}

function inspectCredentialState(
  state: RelayV2HostCredentialState,
): RelayV2HostCredentialInspection {
  return {
    credentialVersion: state.credentialVersion,
    hostId: state.hostId,
    principalId: state.principalId,
    grantId: state.grantId,
    accessJti: state.accessJti,
    accessExpiresAtMs: state.accessExpiresAtMs,
    refreshExpiresAtMs: state.refreshExpiresAtMs,
    pendingCredentialAttempt: copyCredentialAttempt(state.pendingCredentialAttempt),
    pendingReauthentication: copyPendingReauthentication(state.pendingReauthentication),
  };
}

function sameCredentialAttempt(
  left: RelayV2HostPendingCredentialAttempt | null,
  right: RelayV2HostPendingCredentialAttempt | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.kind === right.kind
      && left.attemptId === right.attemptId
      && left.oldCredentialVersion === right.oldCredentialVersion
      && left.oldSecretReference === right.oldSecretReference;
}

function sameExchangeCutBinding(
  left: RelayV2HostCredentialExchangeCutBinding,
  right: RelayV2HostCredentialExchangeCutBinding,
): boolean {
  return left.credentialReference === right.credentialReference
    && left.hostId === right.hostId
    && left.statePresent === right.statePresent
    && left.oldCredentialVersion === right.oldCredentialVersion
    && sameCredentialAttempt(
      left.pendingCredentialAttempt,
      right.pendingCredentialAttempt,
    );
}

function stateMatchesExchangeCut(
  current: RelayV2HostCredentialState | null,
  binding: RelayV2HostCredentialExchangeCutBinding,
): boolean {
  if (!binding.statePresent) return current === null;
  return current !== null
    && current.hostId === binding.hostId
    && current.credentialVersion === binding.oldCredentialVersion
    && sameCredentialAttempt(
      current.pendingCredentialAttempt,
      binding.pendingCredentialAttempt,
    );
}

function validateConnectionAttemptBinding(
  value: unknown,
): RelayV2HostCredentialConnectionAttemptBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "requestId", "controllerGeneration", "hostId", "hostEpoch",
      "hostInstanceId", "credentialReference",
    ])
    || !isRelayV2AuthIdentifier(value.requestId)
    || !isCanonicalCounter(value.controllerGeneration)
    || value.controllerGeneration === "0"
    || !isRelayV2AuthIdentifier(value.hostId)
    || !isRelayV2AuthIdentifier(value.hostEpoch)
    || !isRelayV2AuthIdentifier(value.hostInstanceId)
    || !isCredentialReference(value.credentialReference)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
  }
  return Object.freeze({
    requestId: value.requestId,
    controllerGeneration: value.controllerGeneration,
    hostId: value.hostId,
    hostEpoch: value.hostEpoch,
    hostInstanceId: value.hostInstanceId,
    credentialReference: value.credentialReference,
  });
}

function validateConnectionCarrierBinding(
  value: unknown,
): RelayV2HostCredentialConnectionCarrierBinding {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "hostId", "hostEpoch", "hostInstanceId", "credentialReference",
    ])
    || !isRelayV2AuthIdentifier(value.hostId)
    || !isRelayV2AuthIdentifier(value.hostEpoch)
    || !isRelayV2AuthIdentifier(value.hostInstanceId)
    || !isCredentialReference(value.credentialReference)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
  }
  return Object.freeze({
    hostId: value.hostId,
    hostEpoch: value.hostEpoch,
    hostInstanceId: value.hostInstanceId,
    credentialReference: value.credentialReference,
  });
}

function connectionCutFromState(
  reference: string,
  state: RelayV2HostCredentialState | null,
): RelayV2HostCredentialConnectionCut {
  if (state === null) return fail("RELAY_V2_HOST_CREDENTIAL_NOT_FOUND");
  if (state.credentialVersion === "0"
    || state.grantId === null
    || state.accessJti === null
    || state.accessToken === null
    || state.accessExpiresAtMs === null) {
    return fail("RELAY_V2_HOST_CREDENTIAL_NOT_READY");
  }
  return {
    reference,
    version: state.credentialVersion,
    hostId: state.hostId,
    grantId: state.grantId,
    accessJti: state.accessJti,
    accessExpiresAtMs: state.accessExpiresAtMs,
  };
}

function stateMatchesConnectionCut(
  state: RelayV2HostCredentialState | null,
  cut: RelayV2HostCredentialConnectionCut,
  accessToken: string | undefined,
): boolean {
  return state !== null
    && accessToken !== undefined
    && state.credentialVersion === cut.version
    && state.hostId === cut.hostId
    && state.grantId === cut.grantId
    && state.accessJti === cut.accessJti
    && state.accessToken === accessToken
    && state.accessExpiresAtMs === cut.accessExpiresAtMs;
}

function sameConnectionCarrierBinding(
  attempt: RelayV2HostCredentialConnectionAttemptBinding,
  carrier: RelayV2HostCredentialConnectionCarrierBinding,
): boolean {
  return attempt.hostId === carrier.hostId
    && attempt.hostEpoch === carrier.hostEpoch
    && attempt.hostInstanceId === carrier.hostInstanceId
    && attempt.credentialReference === carrier.credentialReference;
}

export function captureRelayV2HostCredentialConnectionAdmission(
  authority: RelayV2HostCredentialAuthority,
  transportOwner: RelayV2HostCredentialConnectionTransportOwner,
  binding: RelayV2HostCredentialConnectionAttemptBinding,
): RelayV2HostCredentialConnectionAdmission {
  return RelayV2HostCredentialAuthority.captureConnectionAdmission(
    connectionAdmissionAuthorityKey,
    authority,
    transportOwner,
    binding,
  );
}

export function createRelayV2HostCredentialConnectionTransportOwner(
  authority: RelayV2HostCredentialAuthority,
): RelayV2HostCredentialConnectionTransportOwner {
  return RelayV2HostCredentialAuthority.createConnectionTransportOwner(
    connectionAdmissionAuthorityKey,
    authority,
  );
}

export function consumeRelayV2HostCredentialConnectionAdmissionForCarrier(
  authority: RelayV2HostCarrierCredentialReferences,
  admission: RelayV2HostCredentialConnectionAdmission,
  binding: RelayV2HostCredentialConnectionCarrierBinding,
): RelayV2HostCredentialConnectionMetadata {
  if (!isRelayV2HostCredentialAuthority(authority)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
  }
  return RelayV2HostCredentialAuthority.consumeConnectionAdmissionForCarrier(
    connectionAdmissionAuthorityKey,
    authority,
    admission,
    binding,
  );
}

export function claimRelayV2HostCredentialConnectionAuthorization(
  authority: RelayV2HostCredentialAuthority,
  transportOwner: RelayV2HostCredentialConnectionTransportOwner,
  admission: RelayV2HostCredentialConnectionAdmission,
): RelayV2HostCredentialConnectionAuthorization {
  return RelayV2HostCredentialAuthority.claimConnectionAuthorization(
    connectionAdmissionAuthorityKey,
    authority,
    transportOwner,
    admission,
  );
}

export function finalizeRelayV2HostCredentialConnectionAuthorization(
  authority: RelayV2HostCredentialAuthority,
  transportOwner: RelayV2HostCredentialConnectionTransportOwner,
  authorization: RelayV2HostCredentialConnectionAuthorization,
  finalizationPort: RelayV2HostCredentialConnectionRequestFinalizationPort,
): void {
  RelayV2HostCredentialAuthority.finalizeConnectionAuthorization(
    connectionAdmissionAuthorityKey,
    authority,
    transportOwner,
    authorization,
    finalizationPort,
  );
}

export function releaseRelayV2HostCredentialConnectionAuthorization(
  authority: RelayV2HostCredentialAuthority,
  transportOwner: RelayV2HostCredentialConnectionTransportOwner,
  authorization: RelayV2HostCredentialConnectionAuthorization,
): void {
  RelayV2HostCredentialAuthority.releaseConnectionAuthorization(
    connectionAdmissionAuthorityKey,
    authority,
    transportOwner,
    authorization,
  );
}

export function releaseRelayV2HostCredentialConnectionAdmission(
  authority: RelayV2HostCredentialAuthority,
  transportOwner: RelayV2HostCredentialConnectionTransportOwner,
  admission: RelayV2HostCredentialConnectionAdmission,
): void {
  RelayV2HostCredentialAuthority.releaseConnectionAdmission(
    connectionAdmissionAuthorityKey,
    authority,
    transportOwner,
    admission,
  );
}

/**
 * Transactional owner for relay-host v2 credentials and pending attempts. Its
 * connection-admission seam performs only the exact, one-shot Authorization
 * write through a bound request-finalization port. The module has no socket or
 * production composition, filesystem, keychain, listener, retry, capability,
 * or fallback work.
 */
export class RelayV2HostCredentialAuthority
implements RelayV2HostCarrierCredentialReferences {
  private readonly storage: RelayV2HostCredentialStorage;
  private readonly secretResolver: RelayV2HostCredentialSecretResolver;
  private readonly activeExchangeCuts = new Map<
  string,
  RelayV2HostCredentialExchangeCutGroup
  >();

  constructor(options: RelayV2HostCredentialAuthorityOptions) {
    if (!isRecord(options)
      || !isRecord(options.storage)
      || typeof options.storage.runExclusive !== "function"
      || !isRecord(options.secretResolver)
      || typeof options.secretResolver.resolve !== "function") {
      return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
    }
    this.storage = options.storage;
    this.secretResolver = options.secretResolver;
    hostCredentialAuthorities.add(this);
  }

  static createConnectionTransportOwner(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
  ): RelayV2HostCredentialConnectionTransportOwner {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const owner = Object.freeze(
      Object.create(null),
    ) as RelayV2HostCredentialConnectionTransportOwner;
    hostCredentialConnectionTransportOwners.set(owner, {
      owner: authority,
    });
    return owner;
  }

  static captureConnectionAdmission(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    transportOwner: RelayV2HostCredentialConnectionTransportOwner,
    rawBinding: RelayV2HostCredentialConnectionAttemptBinding,
  ): RelayV2HostCredentialConnectionAdmission {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)
      || hostCredentialConnectionTransportOwners.get(transportOwner)?.owner !== authority) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const binding = validateConnectionAttemptBinding(rawBinding);
    return authority.exclusive(binding.credentialReference, (transaction) => {
      const read = authority.validateRead(transaction.read());
      const state = read.state === null
        ? null
        : decodeRelayV2HostCredentialState(read.state, binding.credentialReference);
      const cut = connectionCutFromState(binding.credentialReference, state);
      if (cut.hostId !== binding.hostId) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      const admission = Object.freeze(
        Object.create(null),
      ) as RelayV2HostCredentialConnectionAdmission;
      hostCredentialConnectionAdmissions.set(admission, {
        owner: authority,
        transportOwner,
        binding,
        cut,
        carrierConsumed: false,
        phase: "issued",
      });
      hostCredentialConnectionSecrets.set(admission, state!.accessToken!);
      return admission;
    });
  }

  static consumeConnectionAdmissionForCarrier(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    admission: RelayV2HostCredentialConnectionAdmission,
    rawBinding: RelayV2HostCredentialConnectionCarrierBinding,
  ): RelayV2HostCredentialConnectionMetadata {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const binding = validateConnectionCarrierBinding(rawBinding);
    const record = typeof admission === "object" && admission !== null
      ? hostCredentialConnectionAdmissions.get(admission)
      : undefined;
    if (!record
      || record.owner !== authority
      || record.phase !== "issued"
      || record.carrierConsumed
      || !sameConnectionCarrierBinding(record.binding, binding)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    return authority.exclusive(binding.credentialReference, (transaction) => {
      const read = authority.validateRead(transaction.read());
      const state = read.state === null
        ? null
        : decodeRelayV2HostCredentialState(read.state, binding.credentialReference);
      if (!stateMatchesConnectionCut(
        state,
        record.cut,
        hostCredentialConnectionSecrets.get(admission),
      )) {
        record.phase = "released";
        hostCredentialConnectionAdmissions.delete(admission);
        hostCredentialConnectionSecrets.delete(admission);
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      record.carrierConsumed = true;
      return Object.freeze({
        reference: record.cut.reference,
        version: record.cut.version,
        grantId: record.cut.grantId,
        accessJti: record.cut.accessJti,
      });
    });
  }

  static claimConnectionAuthorization(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    transportOwner: RelayV2HostCredentialConnectionTransportOwner,
    admission: RelayV2HostCredentialConnectionAdmission,
  ): RelayV2HostCredentialConnectionAuthorization {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const transport = hostCredentialConnectionTransportOwners.get(transportOwner);
    const record = typeof admission === "object" && admission !== null
      ? hostCredentialConnectionAdmissions.get(admission)
      : undefined;
    if (!transport
      || transport.owner !== authority
      || !record
      || record.owner !== authority
      || record.transportOwner !== transportOwner
      || record.phase !== "issued"
      || !record.carrierConsumed) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    return authority.exclusive(
      record.binding.credentialReference,
      (transaction) => {
        const read = authority.validateRead(transaction.read());
        const state = read.state === null
          ? null
          : decodeRelayV2HostCredentialState(read.state, record.binding.credentialReference);
        record.phase = "released";
        hostCredentialConnectionAdmissions.delete(admission);
        const accessToken = hostCredentialConnectionSecrets.get(admission);
        hostCredentialConnectionSecrets.delete(admission);
        if (!stateMatchesConnectionCut(state, record.cut, accessToken)) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
        }
        const authorization = Object.freeze(
          Object.create(null),
        ) as RelayV2HostCredentialConnectionAuthorization;
        hostCredentialConnectionAuthorizations.set(authorization, {
          owner: authority,
          transportOwner,
          cut: record.cut,
        });
        hostCredentialConnectionAuthorizationSecrets.set(authorization, accessToken!);
        return authorization;
      },
    );
  }

  static finalizeConnectionAuthorization(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    transportOwner: RelayV2HostCredentialConnectionTransportOwner,
    authorization: RelayV2HostCredentialConnectionAuthorization,
    finalizationPort: RelayV2HostCredentialConnectionRequestFinalizationPort,
  ): void {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const record = typeof authorization === "object" && authorization !== null
      ? hostCredentialConnectionAuthorizations.get(authorization)
      : undefined;
    let descriptors: PropertyDescriptorMap;
    try {
      if (typeof finalizationPort !== "object"
        || finalizationPort === null
        || Object.getPrototypeOf(finalizationPort) !== null
        || !Object.isFrozen(finalizationPort)) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      descriptors = Object.getOwnPropertyDescriptors(finalizationPort);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const descriptor = descriptors.finalize;
    if (!record
      || record.owner !== authority
      || record.transportOwner !== transportOwner
      || Reflect.ownKeys(descriptors).length !== 1
      || !descriptor
      || descriptor.enumerable !== false
      || descriptor.configurable !== false
      || descriptor.writable !== false
      || typeof descriptor.value !== "function") {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const accessToken = hostCredentialConnectionAuthorizationSecrets.get(authorization);
    hostCredentialConnectionAuthorizations.delete(authorization);
    hostCredentialConnectionAuthorizationSecrets.delete(authorization);
    if (accessToken === undefined) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const validationProof = Object.freeze(Object.create(null));
    const validated = authority.exclusive(record.cut.reference, (transaction) => {
      const read = authority.validateRead(transaction.read());
      const state = read.state === null
        ? null
        : decodeRelayV2HostCredentialState(read.state, record.cut.reference);
      if (!stateMatchesConnectionCut(state, record.cut, accessToken)) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      return validationProof;
    });
    if (validated !== validationProof) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    Reflect.apply(descriptor.value, finalizationPort, [`Bearer ${accessToken}`]);
  }

  static releaseConnectionAuthorization(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    transportOwner: RelayV2HostCredentialConnectionTransportOwner,
    authorization: RelayV2HostCredentialConnectionAuthorization,
  ): void {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) return;
    const record = typeof authorization === "object" && authorization !== null
      ? hostCredentialConnectionAuthorizations.get(authorization)
      : undefined;
    if (!record || record.owner !== authority || record.transportOwner !== transportOwner) return;
    hostCredentialConnectionAuthorizations.delete(authorization);
    hostCredentialConnectionAuthorizationSecrets.delete(authorization);
  }

  static releaseConnectionAdmission(
    authorityKey: unknown,
    authority: RelayV2HostCredentialAuthority,
    transportOwner: RelayV2HostCredentialConnectionTransportOwner,
    admission: RelayV2HostCredentialConnectionAdmission,
  ): void {
    if (authorityKey !== connectionAdmissionAuthorityKey
      || !isRelayV2HostCredentialAuthority(authority)) return;
    const record = typeof admission === "object" && admission !== null
      ? hostCredentialConnectionAdmissions.get(admission)
      : undefined;
    if (!record || record.owner !== authority || record.transportOwner !== transportOwner) return;
    record.phase = "released";
    hostCredentialConnectionAdmissions.delete(admission);
    hostCredentialConnectionSecrets.delete(admission);
  }

  read(reference: string): RelayV2HostCredentialRecord {
    if (!isCredentialReference(reference)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_NOT_FOUND");
    }
    const state = this.readState(reference);
    if (!state) return fail("RELAY_V2_HOST_CREDENTIAL_NOT_FOUND");
    if (state.credentialVersion === "0"
      || state.grantId === null
      || state.accessJti === null
      || state.accessToken === null) {
      return fail("RELAY_V2_HOST_CREDENTIAL_NOT_READY");
    }
    const record = {
      reference,
      version: state.credentialVersion,
      grantId: state.grantId,
      accessJti: state.accessJti,
    } as RelayV2HostCredentialRecord;
    Object.defineProperty(record, "accessToken", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: state.accessToken,
    });
    return Object.freeze(record);
  }

  inspect(reference: string): RelayV2HostCredentialInspection | null {
    if (!isCredentialReference(reference)) return null;
    const state = this.readState(reference);
    if (!state) return null;
    return inspectCredentialState(state);
  }

  captureExchangeCut(
    input: RelayV2HostCredentialExchangeCutInput,
  ): RelayV2HostCredentialCapturedExchangeCut {
    if (!isRecord(input)
      || !hasExactKeys(input, ["credentialReference", "hostId"])
      || !isCredentialReference(input.credentialReference)
      || !isRelayV2AuthIdentifier(input.hostId)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    return this.exclusive(input.credentialReference, (transaction) => {
      const read = this.validateRead(transaction.read());
      const current = read.state === null
        ? null
        : decodeRelayV2HostCredentialState(read.state, input.credentialReference);
      if (current !== null && current.hostId !== input.hostId) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      const binding: RelayV2HostCredentialExchangeCutBinding = {
        credentialReference: input.credentialReference,
        hostId: input.hostId,
        statePresent: current !== null,
        oldCredentialVersion: current?.credentialVersion ?? "0",
        pendingCredentialAttempt: copyCredentialAttempt(
          current?.pendingCredentialAttempt ?? null,
        ),
      };
      let group = this.activeExchangeCuts.get(input.credentialReference);
      if (!group
        || group.phase === "released"
        || !sameExchangeCutBinding(group.binding, binding)) {
        group = {
          owner: this,
          binding,
          phase: "issued",
          candidate: null,
          winner: null,
          members: new Set(),
        };
        this.activeExchangeCuts.set(input.credentialReference, group);
      }
      const cut = Object.freeze(Object.create(null)) as RelayV2HostCredentialExchangeCut;
      const record: RelayV2HostCredentialExchangeCutRecord = {
        owner: this,
        cut,
        group,
        phase: "issued",
        consumer: null,
      };
      group.members.add(record);
      if (group.phase === "issued" && group.candidate === null) group.candidate = record;
      hostCredentialExchangeCuts.set(cut, record);
      return {
        inspection: current === null ? null : inspectCredentialState(current),
        cut,
      };
    });
  }

  releaseIssuedExchangeCut(cut: RelayV2HostCredentialExchangeCut): void {
    const record = typeof cut === "object" && cut !== null
      ? hostCredentialExchangeCuts.get(cut)
      : undefined;
    if (!record || record.owner !== this || record.phase !== "issued") return;
    record.phase = "released";
    const group = record.group;
    group.members.delete(record);
    if (group.phase === "issued" && group.candidate === record) {
      this.releaseExchangeCutGroup(group);
    }
  }

  prepareBootstrap(input: RelayV2HostBootstrapPreparation): RelayV2HostPreparedBootstrap {
    return this.prepareBootstrapAtCut(null, input);
  }

  prepareBootstrapFromCut(
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostBootstrapPreparation,
  ): RelayV2HostPreparedBootstrapFromCut {
    const consumption = { cut, consumer: Object.freeze({}) };
    try {
      const prepared = this.prepareBootstrapAtCut(consumption, input);
      return {
        prepared,
        lease: this.createExchangeLease(consumption),
      };
    } catch (error) {
      this.releaseExchangeCutForConsumer(consumption);
      this.releaseIssuedExchangeCut(cut);
      throw error;
    }
  }

  private prepareBootstrapAtCut(
    consumption: RelayV2HostCredentialExchangeCutConsumption | null,
    input: RelayV2HostBootstrapPreparation,
  ): RelayV2HostPreparedBootstrap {
    validateAttemptInput(input);
    if (!isRelayV2AuthIdentifier(input.hostId)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const fence = this.transition(input.credentialReference, (current) => {
      if (current) {
        const pending = current.pendingCredentialAttempt;
        if (current.credentialVersion !== "0"
          || current.hostId !== input.hostId
          || pending?.kind !== "bootstrap"
          || pending.oldSecretReference !== input.oldSecretReference) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
        }
        return {
          kind: "unchanged",
          value: this.attemptFence(input.credentialReference, pending),
        };
      }
      const pending: RelayV2HostPendingCredentialAttempt = {
        kind: "bootstrap",
        attemptId: input.attemptId,
        oldCredentialVersion: "0",
        oldSecretReference: input.oldSecretReference,
      };
      return {
        kind: "replace",
        value: this.attemptFence(input.credentialReference, pending),
        replacement: {
          credentialVersion: "0",
          hostId: input.hostId,
          principalId: null,
          grantId: null,
          accessToken: null,
          accessExpiresAtMs: null,
          refreshToken: null,
          refreshExpiresAtMs: null,
          accessJti: null,
          pendingCredentialAttempt: pending,
          pendingReauthentication: null,
        },
      };
    }, consumption);
    if (consumption !== null) {
      this.bindConsumedCutToFence(consumption.cut, fence, input.hostId);
    }
    const bootstrapToken = this.resolveBootstrapSecret(fence.oldSecretReference);
    return {
      fence,
      credential: {
        bootstrapToken,
        hostId: input.hostId,
      },
    };
  }

  applyBootstrapResponse(
    fence: RelayV2HostCredentialAttemptFence,
    response: RelayV2HostBootstrapResponse,
  ): RelayV2HostCredentialResponseCommit {
    const reference = validateReference(fence?.credentialReference);
    return this.transition(reference, (current) => {
      if (!current
        || current.credentialVersion !== fence.oldCredentialVersion
        || response?.bootstrapAttemptId !== fence.attemptId
        || !fenceMatches(current.pendingCredentialAttempt, fence, "bootstrap")) {
        return {
          kind: "unchanged",
          value: {
            status: "stale",
            credentialVersion: current?.credentialVersion ?? null,
          },
        };
      }
      const claims = validateBootstrapResponse(response);
      if (response.hostId !== current.hostId
        || claims.hostId !== current.hostId
        || claims.principalId !== response.principalId
        || claims.grantId !== response.grantId
        || claims.exp * 1_000 !== response.accessExpiresAtMs) {
        return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
      }
      const nextVersion = nextCredentialVersion(current.credentialVersion);
      return {
        kind: "replace",
        value: { status: "applied", credentialVersion: nextVersion },
        replacement: {
          ...current,
          credentialVersion: nextVersion,
          principalId: response.principalId,
          grantId: response.grantId,
          accessToken: response.accessToken,
          accessExpiresAtMs: response.accessExpiresAtMs,
          refreshToken: response.refreshToken,
          refreshExpiresAtMs: response.refreshExpiresAtMs,
          accessJti: claims.jti,
          pendingCredentialAttempt: null,
        },
      };
    });
  }

  prepareRefresh(input: RelayV2HostRefreshPreparation): RelayV2HostPreparedRefresh {
    return this.prepareRefreshAtCut(null, input);
  }

  prepareRefreshFromCut(
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostRefreshPreparation,
  ): RelayV2HostPreparedRefreshFromCut {
    const consumption = { cut, consumer: Object.freeze({}) };
    try {
      const prepared = this.prepareRefreshAtCut(consumption, input);
      return {
        prepared,
        lease: this.createExchangeLease(consumption),
      };
    } catch (error) {
      this.releaseExchangeCutForConsumer(consumption);
      this.releaseIssuedExchangeCut(cut);
      throw error;
    }
  }

  private prepareRefreshAtCut(
    consumption: RelayV2HostCredentialExchangeCutConsumption | null,
    input: RelayV2HostRefreshPreparation,
  ): RelayV2HostPreparedRefresh {
    validateAttemptInput(input);
    let observedCredentialVersion: string | null = null;
    const winner = this.transition(input.credentialReference, (current) => {
      if (!current
        || current.credentialVersion === "0"
        || current.grantId === null
        || current.refreshToken === null) {
        return fail("RELAY_V2_HOST_CREDENTIAL_NOT_READY");
      }
      const existing = current.pendingCredentialAttempt;
      if (existing) {
        if (existing.kind !== "refresh"
          || existing.oldSecretReference !== input.oldSecretReference) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
        }
        return {
          kind: "unchanged",
          value: {
            fence: this.attemptFence(input.credentialReference, existing),
            grantId: current.grantId,
            expectedRefreshToken: current.refreshToken,
          },
        };
      }
      if (observedCredentialVersion !== null
        && observedCredentialVersion !== current.credentialVersion) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      observedCredentialVersion = current.credentialVersion;
      const pending: RelayV2HostPendingCredentialAttempt = {
        kind: "refresh",
        attemptId: input.attemptId,
        oldCredentialVersion: current.credentialVersion,
        oldSecretReference: input.oldSecretReference,
      };
      return {
        kind: "replace",
        value: {
          fence: this.attemptFence(input.credentialReference, pending),
          grantId: current.grantId,
          expectedRefreshToken: current.refreshToken,
        },
        replacement: { ...current, pendingCredentialAttempt: pending },
      };
    }, consumption);
    if (consumption !== null) {
      const record = hostCredentialExchangeCuts.get(consumption.cut);
      if (!record || record.owner !== this) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      this.bindConsumedCutToFence(
        consumption.cut,
        winner.fence,
        record.group.binding.hostId,
      );
    }
    const refreshToken = this.resolveRefreshSecret(winner.fence.oldSecretReference);
    if (refreshToken !== winner.expectedRefreshToken) {
      return fail("RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE");
    }
    return {
      fence: winner.fence,
      credential: {
        grantId: winner.grantId,
        refreshToken,
      },
    };
  }

  applyRefreshResponse(
    fence: RelayV2HostCredentialAttemptFence,
    response: RelayV2HostRefreshResponse,
  ): RelayV2HostCredentialResponseCommit {
    const reference = validateReference(fence?.credentialReference);
    return this.transition(reference, (current) => {
      if (!current
        || current.credentialVersion !== fence.oldCredentialVersion
        || response?.refreshAttemptId !== fence.attemptId
        || !fenceMatches(current.pendingCredentialAttempt, fence, "refresh")) {
        return {
          kind: "unchanged",
          value: {
            status: "stale",
            credentialVersion: current?.credentialVersion ?? null,
          },
        };
      }
      const claims = validateRefreshResponse(response);
      if (current.principalId === null
        || current.grantId === null
        || response.principalId !== current.principalId
        || response.grantId !== current.grantId
        || response.hostId !== current.hostId
        || claims.principalId !== current.principalId
        || claims.grantId !== current.grantId
        || claims.hostId !== current.hostId
        || claims.exp * 1_000 !== response.accessExpiresAtMs) {
        return fail("RELAY_V2_HOST_CREDENTIAL_STATE_INVALID");
      }
      const nextVersion = nextCredentialVersion(current.credentialVersion);
      return {
        kind: "replace",
        value: { status: "applied", credentialVersion: nextVersion },
        replacement: {
          ...current,
          credentialVersion: nextVersion,
          accessToken: response.accessToken,
          accessExpiresAtMs: response.accessExpiresAtMs,
          refreshToken: response.refreshToken,
          refreshExpiresAtMs: response.refreshExpiresAtMs,
          accessJti: claims.jti,
          pendingCredentialAttempt: null,
        },
      };
    });
  }

  prepareReauthentication(
    input: RelayV2HostReauthenticationPreparation,
  ): RelayV2HostPreparedReauthentication {
    if (!isRecord(input)
      || !isCredentialReference(input.credentialReference)
      || !isRelayV2AuthIdentifier(input.requestId)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    return this.transition(input.credentialReference, (current) => {
      if (!current
        || current.credentialVersion === "0"
        || current.grantId === null
        || current.accessJti === null
        || current.accessToken === null) {
        return fail("RELAY_V2_HOST_CREDENTIAL_NOT_READY");
      }
      const existing = current.pendingReauthentication;
      if (existing
        && existing.credentialReference === input.credentialReference
        && existing.credentialVersion === current.credentialVersion
        && existing.grantId === current.grantId
        && existing.accessJti === current.accessJti) {
        return {
          kind: "unchanged",
          value: {
            fence: {
              reference: existing.credentialReference,
              version: existing.credentialVersion,
              requestId: existing.requestId,
              grantId: existing.grantId,
              accessJti: existing.accessJti,
            },
            accessToken: current.accessToken,
          },
        };
      }
      if (existing?.requestId === input.requestId) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
      }
      const pending: RelayV2HostPendingReauthentication = {
        credentialReference: input.credentialReference,
        credentialVersion: current.credentialVersion,
        requestId: input.requestId,
        grantId: current.grantId,
        accessJti: current.accessJti,
      };
      return {
        kind: "replace",
        value: {
          fence: {
            reference: pending.credentialReference,
            version: pending.credentialVersion,
            requestId: pending.requestId,
            grantId: pending.grantId,
            accessJti: pending.accessJti,
          },
          accessToken: current.accessToken,
        },
        replacement: { ...current, pendingReauthentication: pending },
      };
    });
  }

  acknowledgeReauthentication(fence: RelayV2HostCredentialAckFence): boolean {
    if (!isRecord(fence)
      || !isCredentialReference(fence.reference)
      || !isCanonicalCounter(fence.version)
      || !isRelayV2AuthIdentifier(fence.requestId)
      || !isRelayV2AuthIdentifier(fence.grantId)
      || !isRelayV2AuthIdentifier(fence.accessJti)) return false;
    return this.transition(fence.reference, (current) => {
      const pending = current?.pendingReauthentication;
      if (!current
        || !pending
        || current.credentialVersion !== fence.version
        || current.grantId !== fence.grantId
        || current.accessJti !== fence.accessJti
        || pending.credentialReference !== fence.reference
        || pending.credentialVersion !== fence.version
        || pending.requestId !== fence.requestId
        || pending.grantId !== fence.grantId
        || pending.accessJti !== fence.accessJti) {
        return { kind: "unchanged", value: false };
      }
      return {
        kind: "replace",
        value: true,
        replacement: { ...current, pendingReauthentication: null },
      };
    });
  }

  private readState(reference: string): RelayV2HostCredentialState | null {
    return this.exclusive(reference, (transaction) => {
      const read = this.validateRead(transaction.read());
      return read.state === null
        ? null
        : decodeRelayV2HostCredentialState(read.state, reference);
    });
  }

  private transition<T>(
    reference: string,
    reduce: (current: RelayV2HostCredentialState | null) => Transition<T>,
    consumption: RelayV2HostCredentialExchangeCutConsumption | null = null,
  ): T {
    return this.exclusive(reference, (transaction) => {
      const cutRecord = consumption === null
        ? null
        : this.consumeExchangeCut(consumption, reference);
      let read = this.validateRead(transaction.read());
      for (let conflicts = 0; conflicts <= MAX_CAS_CONFLICTS; conflicts += 1) {
        const current = read.state === null
          ? null
          : decodeRelayV2HostCredentialState(read.state, reference);
        if (cutRecord !== null
          && !stateMatchesExchangeCut(current, cutRecord.group.binding)) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
        }
        const transition = reduce(current);
        if (transition.kind === "unchanged") return transition.value;
        const replacement = decodeRelayV2HostCredentialState(
          transition.replacement,
          reference,
        );
        let result: RelayV2HostCredentialStorageCasResult;
        try {
          result = transaction.compareAndSwap(read.revision, replacement);
        } catch {
          return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
        }
        if (!isRecord(result) || typeof result.status !== "string") {
          return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
        }
        if (result.status === "swapped") return transition.value;
        if (result.status === "uncertain") {
          return fail("RELAY_V2_HOST_CREDENTIAL_COMMIT_UNCERTAIN");
        }
        if (result.status !== "conflict" || !Object.hasOwn(result, "current")) {
          return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
        }
        if (conflicts === MAX_CAS_CONFLICTS) {
          return fail("RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT");
        }
        read = this.validateRead(result.current);
      }
      return fail("RELAY_V2_HOST_CREDENTIAL_CAS_CONFLICT");
    });
  }

  private consumeExchangeCut(
    consumption: RelayV2HostCredentialExchangeCutConsumption,
    reference: string,
  ): RelayV2HostCredentialExchangeCutRecord {
    const cut = consumption.cut;
    const record = typeof cut === "object" && cut !== null
      ? hostCredentialExchangeCuts.get(cut)
      : undefined;
    if (!record
      || record.owner !== this
      || record.phase !== "issued"
      || record.group.owner !== this
      || record.group.phase !== "issued"
      || record.group.candidate !== record
      || record.group.binding.credentialReference !== reference
      || this.activeExchangeCuts.get(reference) !== record.group) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    record.phase = "consumed";
    record.consumer = consumption.consumer;
    record.group.phase = "consumed";
    record.group.winner = record;
    return record;
  }

  private releaseExchangeCutForConsumer(
    consumption: RelayV2HostCredentialExchangeCutConsumption,
  ): void {
    const record = hostCredentialExchangeCuts.get(consumption.cut);
    if (!record
      || record.owner !== this
      || record.consumer !== consumption.consumer) return;
    this.releaseExchangeCutGroup(record.group);
  }

  releaseExchangeLease(lease: RelayV2HostCredentialExchangeLease): void {
    const leaseRecord = typeof lease === "object" && lease !== null
      ? hostCredentialExchangeLeases.get(lease)
      : undefined;
    if (!leaseRecord
      || leaseRecord.owner !== this
      || leaseRecord.released
      || leaseRecord.cutRecord.consumer !== leaseRecord.consumer
      || leaseRecord.cutRecord.group.winner !== leaseRecord.cutRecord) return;
    leaseRecord.released = true;
    this.releaseExchangeCutGroup(leaseRecord.cutRecord.group);
  }

  private createExchangeLease(
    consumption: RelayV2HostCredentialExchangeCutConsumption,
  ): RelayV2HostCredentialExchangeLease {
    const record = hostCredentialExchangeCuts.get(consumption.cut);
    if (!record
      || record.owner !== this
      || record.phase !== "consumed"
      || record.consumer !== consumption.consumer
      || record.group.winner !== record) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    const lease = Object.freeze(Object.create(null)) as RelayV2HostCredentialExchangeLease;
    hostCredentialExchangeLeases.set(lease, {
      owner: this,
      lease,
      cutRecord: record,
      consumer: consumption.consumer,
      released: false,
    });
    return lease;
  }

  private releaseExchangeCutGroup(group: RelayV2HostCredentialExchangeCutGroup): void {
    if (group.owner !== this || group.phase === "released") return;
    group.phase = "released";
    for (const member of group.members) {
      member.phase = "released";
      member.consumer = null;
    }
    group.members.clear();
    group.candidate = null;
    group.winner = null;
    if (this.activeExchangeCuts.get(group.binding.credentialReference) === group) {
      this.activeExchangeCuts.delete(group.binding.credentialReference);
    }
  }

  private bindConsumedCutToFence(
    cut: RelayV2HostCredentialExchangeCut,
    fence: RelayV2HostCredentialAttemptFence,
    hostId: string,
  ): void {
    const record = hostCredentialExchangeCuts.get(cut);
    if (!record
      || record.owner !== this
      || record.phase !== "consumed"
      || record.group.winner !== record
      || record.group.binding.credentialReference !== fence.credentialReference
      || record.group.binding.hostId !== hostId
      || record.group.binding.oldCredentialVersion !== fence.oldCredentialVersion) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATTEMPT_CONFLICT");
    }
    record.group.binding = {
      credentialReference: fence.credentialReference,
      hostId,
      statePresent: true,
      oldCredentialVersion: fence.oldCredentialVersion,
      pendingCredentialAttempt: {
        kind: fence.kind,
        attemptId: fence.attemptId,
        oldCredentialVersion: fence.oldCredentialVersion,
        oldSecretReference: fence.oldSecretReference,
      },
    };
  }

  private exclusive<T>(
    reference: string,
    operation: (transaction: RelayV2HostCredentialStorageTransaction) => T,
  ): T {
    try {
      return this.storage.runExclusive(reference, operation);
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAuthorityError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
    }
  }

  private validateRead(value: unknown): RelayV2HostCredentialStorageRead {
    if (!isRecord(value)
      || !hasExactKeys(value, ["state", "revision"])
    ) {
      return fail("RELAY_V2_HOST_CREDENTIAL_STORAGE_UNAVAILABLE");
    }
    return {
      state: value.state,
      revision: value.revision,
    };
  }

  private resolveBootstrapSecret(reference: string): string {
    try {
      const secret = this.secretResolver.resolve(reference);
      if (!isVisibleToken(secret, "twhostboot2.")) {
        return fail("RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE");
      }
      return secret;
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAuthorityError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE");
    }
  }

  private resolveRefreshSecret(reference: string): string {
    try {
      const secret = this.secretResolver.resolve(reference);
      if (!isVisibleToken(secret, "twref2.")) {
        return fail("RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE");
      }
      return secret;
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAuthorityError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_SECRET_UNAVAILABLE");
    }
  }

  private attemptFence(
    credentialReference: string,
    pending: RelayV2HostPendingCredentialAttempt,
  ): RelayV2HostCredentialAttemptFence {
    return {
      credentialReference,
      kind: pending.kind,
      attemptId: pending.attemptId,
      oldCredentialVersion: pending.oldCredentialVersion,
      oldSecretReference: pending.oldSecretReference,
    };
  }
}
