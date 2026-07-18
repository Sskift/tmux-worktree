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

/**
 * Pure transactional owner for relay-host v2 credentials and pending attempts.
 * The module has no production composition and performs no filesystem,
 * keychain, network, carrier, capability, or fallback work.
 */
export class RelayV2HostCredentialAuthority
implements RelayV2HostCarrierCredentialReferences {
  private readonly storage: RelayV2HostCredentialStorage;
  private readonly secretResolver: RelayV2HostCredentialSecretResolver;

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

  prepareBootstrap(input: RelayV2HostBootstrapPreparation): RelayV2HostPreparedBootstrap {
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
    });
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
    });
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
      return read.state === null ? null : parseState(read.state, reference);
    });
  }

  private transition<T>(
    reference: string,
    reduce: (current: RelayV2HostCredentialState | null) => Transition<T>,
  ): T {
    return this.exclusive(reference, (transaction) => {
      let read = this.validateRead(transaction.read());
      for (let conflicts = 0; conflicts <= MAX_CAS_CONFLICTS; conflicts += 1) {
        const current = read.state === null ? null : parseState(read.state, reference);
        const transition = reduce(current);
        if (transition.kind === "unchanged") return transition.value;
        const replacement = parseState(transition.replacement, reference);
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
