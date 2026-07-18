import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as systemRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  RelayV2AuthError,
  verifyRelayV2AccessAuthorization,
  type RelayV2AuthContext,
  type RelayV2GrantBinding,
} from "./auth.js";
import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import type {
  RelayV2AuthControlDecision,
  RelayV2AuthControlRequest,
  RelayV2BrokerAuthControlAuthority,
  RelayV2BrokerConnectionAuthorization,
  RelayV2LiveAuthorizationCommitBarrier,
  RelayV2LiveAuthorizationFencePort,
  RelayV2LiveAuthorizationInvalidation,
  RelayV2StructuredError,
} from "./brokerCore.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RelayV2BrokerCredentialStateStoreError,
  type RelayV2BrokerCredentialStateRead,
  type RelayV2BrokerCredentialStateRevision,
  type RelayV2BrokerCredentialStateStore,
  type RelayV2BrokerCredentialStateTransaction,
} from "./brokerCredentialStateStore.js";
import {
  RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
  RelayV2ContinuityAnchor,
  RelayV2ContinuityAnchorError,
  type RelayV2ContinuityAnchorOptions,
  type RelayV2ContinuityCheckpoint,
  type RelayV2ContinuityLocalCasResult,
} from "./continuityAnchor.js";
import {
  parseRelayV2IssuerKeyring,
  prepareRelayV2AccessTokenIssuance,
  removeRelayV2VerifyOnlyKey,
  rotateRelayV2IssuerKeyring,
  verifyRelayV2IssuerAccessToken,
  type RelayV2IssuerKeyring,
} from "./issuer.js";
import {
  isRelayV2AuthIdentifier,
  RELAY_V2_MAX_ACCESS_TTL_SECONDS,
  RELAY_V2_MAX_CLOCK_SKEW_SECONDS,
  type RelayV2AccessRole,
} from "./token.js";

const RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_LEGACY_ENVELOPE_VERSION = 1 as const;
const RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_HOST_BOOTSTRAP_ENVELOPE_VERSION = 2 as const;
const RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_ENVELOPE_VERSION = 3 as const;
const RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_MAX_BYTES = 8 * 1024 * 1024;
export const RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS = 600_000;
export const RELAY_V2_BROKER_CREDENTIAL_ENROLLMENT_MAX_FAILURES = 5;
export const RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES = 5;
export const RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS = 300_000;
export const RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_WINDOW_MS = 60_000;
export const RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_MAX_ATTEMPTS = 20;
const RELAY_V2_BROKER_CREDENTIAL_SOURCE_ADMISSION_TTL_MS = 15_000;

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const MAX_ENROLLMENTS = 2_048;
const MAX_HOST_BOOTSTRAPS = 2_048;
const MAX_GRANTS = 4_096;
const MAX_REPLAYS = 4_096;
const MAX_RATE_BUCKETS = 4_096;
const MAX_REPLAY_PLAINTEXT_BYTES = 64 * 1024;
const MAX_REPLAY_CIPHERTEXT_BYTES = MAX_REPLAY_PLAINTEXT_BYTES + 64;
const MAX_SOURCE_ADMISSIONS = 256;
const MAX_ISSUER_KEY_IDENTITIES = 1_024;
const MAX_REPLAY_DECRYPT_ONLY_KEYS = 32;
const MAX_REPLAY_KEY_ROTATIONS = 1_023;
const MAX_ACCESS_TOKEN_BYTES = 8_192;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]+$/;
const AUTHORITY_ERROR_BRAND = Symbol.for(
  "tmux-worktree.relay-v2.broker-credential-authority-error.v1",
);

export type RelayV2BrokerCredentialAuthorityErrorCode =
  | "AUTHORITY_NOT_READY"
  | "AUTHORITY_CLOSED"
  | "INVALID_ARGUMENT"
  | "STATE_INVALID"
  | "STATE_CONFLICT"
  | "STATE_CAPACITY_EXHAUSTED"
  | "STORE_PUBLICATION_UNCERTAIN"
  | "EXTERNAL_ANCHOR_UNCERTAIN"
  | "EXTERNAL_ANCHOR_CONFLICT"
  | "EXTERNAL_CONTINUITY_UNAVAILABLE"
  | "EXTERNAL_CONTINUITY_INVALID"
  | "CLOSE_BARRIER_FAILED"
  | "LIVE_AUTHORIZATION_FENCE_UNAVAILABLE"
  | "BUSY"
  | "IDEMPOTENCY_CONFLICT"
  | "AUTH_INVALID"
  | "ROLE_MISMATCH"
  | "PERMISSION_DENIED"
  | "GRANT_NOT_FOUND"
  | "RATE_LIMITED";

const AUTHORITY_ERROR_MESSAGES: Readonly<Record<
  RelayV2BrokerCredentialAuthorityErrorCode,
  string
>> = Object.freeze({
  AUTHORITY_NOT_READY: "Relay v2 broker credential authority is not ready",
  AUTHORITY_CLOSED: "Relay v2 broker credential authority is closed",
  INVALID_ARGUMENT: "Relay v2 broker credential authority input is invalid",
  STATE_INVALID: "Relay v2 broker credential authority state is invalid",
  STATE_CONFLICT: "Relay v2 broker credential authority state changed unexpectedly",
  STATE_CAPACITY_EXHAUSTED: "Relay v2 broker credential authority capacity is exhausted",
  STORE_PUBLICATION_UNCERTAIN: "Relay v2 broker credential state publication is uncertain",
  EXTERNAL_ANCHOR_UNCERTAIN: "Relay v2 broker credential external anchor commit is uncertain",
  EXTERNAL_ANCHOR_CONFLICT: "Relay v2 broker credential external anchor changed unexpectedly",
  EXTERNAL_CONTINUITY_UNAVAILABLE: "Relay v2 broker credential external continuity is unavailable",
  EXTERNAL_CONTINUITY_INVALID: "Relay v2 broker credential external continuity is invalid",
  CLOSE_BARRIER_FAILED: "Relay v2 broker credential authority close barrier failed",
  LIVE_AUTHORIZATION_FENCE_UNAVAILABLE: "Relay v2 broker live authorization fence is unavailable",
  BUSY: "Relay v2 broker credential authority is busy",
  IDEMPOTENCY_CONFLICT: "Relay v2 broker credential request conflicts with a prior request",
  AUTH_INVALID: "Relay v2 credential is invalid",
  ROLE_MISMATCH: "Relay v2 credential role does not match",
  PERMISSION_DENIED: "Relay v2 credential operation is not permitted",
  GRANT_NOT_FOUND: "Relay v2 grant was not found",
  RATE_LIMITED: "Relay v2 credential operation is rate limited",
});

type RelayV2BrokerCredentialAuthorityWithdrawalReason =
  | RelayV2BrokerCredentialAuthorityErrorCode
  | "close_requested";

export class RelayV2BrokerCredentialAuthorityError extends Error {
  constructor(
    readonly code: RelayV2BrokerCredentialAuthorityErrorCode,
    readonly withdrawalReason?: RelayV2BrokerCredentialAuthorityWithdrawalReason,
  ) {
    super(AUTHORITY_ERROR_MESSAGES[code]);
    this.name = "RelayV2BrokerCredentialAuthorityError";
    Object.defineProperty(this, AUTHORITY_ERROR_BRAND, { value: true });
  }
}

/** Preserves exact authority errors across separately bundled entry points. */
export function isRelayV2BrokerCredentialAuthorityError(
  error: unknown,
): error is RelayV2BrokerCredentialAuthorityError {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
      return false;
    }
    const candidate = error as Record<PropertyKey, unknown>;
    return candidate[AUTHORITY_ERROR_BRAND] === true
      && typeof candidate.code === "string"
      && Object.prototype.hasOwnProperty.call(AUTHORITY_ERROR_MESSAGES, candidate.code);
  } catch {
    return false;
  }
}

export type RelayV2BrokerCredentialAuthorityContinuityReadiness =
  | { status: "opening" }
  | { status: "ready" }
  | {
      status: "withdrawn";
      reason: RelayV2BrokerCredentialAuthorityWithdrawalReason;
    }
  | {
      status: "closed";
      reason: RelayV2BrokerCredentialAuthorityWithdrawalReason;
    };

export interface RelayV2BrokerCredentialAuthorityGenesis {
  issuerKeyring: RelayV2IssuerKeyring;
  issuerUrl: string;
  relayUrl: string;
}

export type RelayV2BrokerCredentialHttpSourceEndpoint =
  | "enrollment_redeem"
  | "client_refresh"
  | "host_bootstrap"
  | "host_refresh"
  | "self_revoke";

declare const relayV2HttpSourceAdmissionBrand: unique symbol;

/**
 * Same-authority, short-lived pre-body admission. It has no serializable
 * representation and is accepted only by the instance that issued it.
 */
export interface RelayV2BrokerCredentialHttpSourceAdmission {
  readonly [relayV2HttpSourceAdmissionBrand]: true;
}

export interface RelayV2BrokerCredentialAuthorityOptions {
  store: RelayV2BrokerCredentialStateStore;
  continuityAnchor: RelayV2ContinuityAnchorOptions;
  genesis: RelayV2BrokerCredentialAuthorityGenesis;
  now?: () => number;
  randomId?: () => string;
  randomBytes?: (length: number) => Uint8Array;
  liveAuthorizationFence?: RelayV2LiveAuthorizationFencePort;
}

export interface RelayV2BrokerCredentialEnrollmentCreated {
  enrollmentId: string;
  enrollmentCode: string;
  hostId: string;
  issuerUrl: string;
  relayUrl: string;
  expiresAtMs: number;
  deduplicated: boolean;
}

export interface RelayV2BrokerCredentialHostBootstrapCreated {
  bootstrapToken: string;
  expiresAtMs: number;
}

export interface RelayV2BrokerCredentialGrantResponseBody {
  principalId: string;
  grantId: string;
  hostId: string;
  accessToken: string;
  accessExpiresAtMs: number;
  refreshToken: string;
  refreshExpiresAtMs: number;
}

export type RelayV2BrokerCredentialGrantCredential =
  | {
      endpoint: "enrollment_redeem";
      body: Readonly<RelayV2BrokerCredentialGrantResponseBody & {
        exchangeAttemptId: string;
        relayUrl: string;
      }>;
      replayed: boolean;
    }
  | {
      endpoint: "client_refresh";
      body: Readonly<RelayV2BrokerCredentialGrantResponseBody & {
        refreshAttemptId: string;
        relayUrl: string;
      }>;
      replayed: boolean;
    }
  | {
      endpoint: "host_bootstrap";
      body: Readonly<RelayV2BrokerCredentialGrantResponseBody & {
        bootstrapAttemptId: string;
      }>;
      replayed: boolean;
    }
  | {
      endpoint: "host_refresh";
      body: Readonly<RelayV2BrokerCredentialGrantResponseBody & {
        refreshAttemptId: string;
      }>;
      replayed: boolean;
    };

export interface RelayV2BrokerCredentialSelfRevokeResult {
  grantId: string;
  revokedAtMs: number;
  alreadyRevoked: boolean;
}

interface EnrollmentRecord {
  enrollmentId: string;
  hostId: string;
  codeHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  failedAttempts: number;
  consumedAtMs: number | null;
}

interface HostBootstrapRecord {
  selector: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  failedAttempts: number;
  terminalAtMs: number | null;
  terminalReason: "consumed" | "failures_exhausted" | null;
}

interface GrantRecord {
  role: RelayV2AccessRole;
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId: string | null;
  refreshTokenHash: string;
  credentialVersion: string;
  refreshExpiresAtMs: number;
  maxAccessExpiresAtMs: number;
  revokedAtMs: number | null;
}

type ReplayOperation =
  | "enrollment.create"
  | "enrollment.redeem"
  | "host.bootstrap"
  | "grant.refresh"
  | "host.reauthenticate"
  | "grant.revoke";

interface ReplayRecord {
  operation: ReplayOperation;
  subjectId: string;
  attemptId: string;
  fingerprint: string;
  replayKeyId: string;
  aadVersion: 1 | 2;
  ciphertextBase64url: string;
  expiresAtMs: number;
}

interface ReplayKeyMaterial {
  replayKeyId: string;
  keyBase64url: string;
  legacyAad: boolean;
}

interface ReplayKeyRotationRecord {
  rotationId: string;
  replayKeyId: string;
  commitSequence: string;
}

interface ReplayKeyring {
  originKeyId: string;
  activeKey: ReplayKeyMaterial;
  decryptOnlyKeys: ReplayKeyMaterial[];
  rotations: ReplayKeyRotationRecord[];
}

interface RateLimitRecord {
  scope: "enrollment.redeem.source" | "host.bootstrap.source";
  subjectHash: string;
  windowStartedAtMs: number;
  attempts: number;
}

interface SourceAdmissionRecord {
  endpoint: RelayV2BrokerCredentialHttpSourceEndpoint;
  sourceHash: string;
  expiresAtMs: number;
  pending: boolean;
}

interface CredentialAuthorityEnvelope {
  version: typeof RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_ENVELOPE_VERSION;
  anchorId: string;
  commitSequence: string;
  commitId: string;
  parentCommitId: string | null;
  lastObservedAtMs: number;
  issuerUrl: string;
  relayUrl: string;
  replayKeyring: ReplayKeyring;
  issuer: RelayV2IssuerKeyring;
  enrollments: EnrollmentRecord[];
  hostBootstraps: HostBootstrapRecord[];
  grants: GrantRecord[];
  replays: ReplayRecord[];
  rateLimits: RateLimitRecord[];
}

type TransitionResult<Result> =
  | {
      disposition: "return";
      value: Result;
      changed: boolean;
      liveAuthorizationInvalidation?: RelayV2LiveAuthorizationInvalidation;
    }
  | {
      disposition: "reject";
      error: RelayV2BrokerCredentialAuthorityError;
      changed: boolean;
    };

class DomainRejection extends Error {
  constructor(readonly authorityError: RelayV2BrokerCredentialAuthorityError) {
    super(authorityError.message);
  }
}

function authorityError(
  code: RelayV2BrokerCredentialAuthorityErrorCode,
): RelayV2BrokerCredentialAuthorityError {
  return new RelayV2BrokerCredentialAuthorityError(code);
}

function invalidState(): never {
  throw authorityError("STATE_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function readExactOwnMethodSnapshot(
  source: unknown,
  keys: readonly string[],
): readonly Function[] | undefined {
  if (!isRecord(source)) return undefined;
  try {
    const actual = Reflect.ownKeys(source);
    if (
      actual.length !== keys.length
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return undefined;
    const methods: Function[] = [];
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || typeof descriptor.value !== "function"
      ) return undefined;
      methods.push(descriptor.value as Function);
    }
    return Object.freeze(methods);
  } catch {
    return undefined;
  }
}

function cloneLiveAuthorizationFencePort(
  source: unknown,
): RelayV2LiveAuthorizationFencePort | undefined {
  const methods = readExactOwnMethodSnapshot(source, ["begin", "failClosed"]);
  if (!methods || !isRecord(source)) return undefined;
  const [begin, failClosed] = methods;
  return Object.freeze({
    begin: (invalidation: RelayV2LiveAuthorizationInvalidation) => (
      Reflect.apply(begin!, source, [invalidation]) as RelayV2LiveAuthorizationCommitBarrier
    ),
    failClosed: () => {
      Reflect.apply(failClosed!, source, []);
    },
  });
}

function cloneLiveAuthorizationCommitBarrier(
  source: unknown,
): RelayV2LiveAuthorizationCommitBarrier | undefined {
  const methods = readExactOwnMethodSnapshot(
    source,
    ["committed", "cancelled", "failClosed"],
  );
  if (!methods || !isRecord(source)) return undefined;
  const [committed, cancelled, failClosed] = methods;
  return Object.freeze({
    committed: (receipt: RelayV2LiveAuthorizationCommitReceipt) => {
      Reflect.apply(committed!, source, [receipt]);
    },
    cancelled: () => {
      Reflect.apply(cancelled!, source, []);
    },
    failClosed: () => {
      Reflect.apply(failClosed!, source, []);
    },
  });
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCanonicalUint64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_UINT64;
  } catch {
    return false;
  }
}

function nextUint64(value: string): string {
  const current = BigInt(value);
  if (current >= MAX_UINT64) throw authorityError("STATE_CAPACITY_EXHAUSTED");
  return (current + 1n).toString(10);
}

function accessTtlSeconds(refreshExpiresAtMs: number, nowMs: number): number | null {
  const remaining = Math.floor(refreshExpiresAtMs / 1_000) - Math.floor(nowMs / 1_000);
  if (remaining <= 0) return null;
  return Math.min(RELAY_V2_MAX_ACCESS_TTL_SECONDS, remaining);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSha256Digest(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) invalidState();
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function exactBase64UrlBytes(value: unknown, expectedLength?: number): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || !CANONICAL_BASE64URL.test(value)
  ) invalidState();
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value
    || (expectedLength !== undefined && bytes.byteLength !== expectedLength)
  ) invalidState();
  return bytes;
}

function exactUrl(value: unknown, protocol: "https:" | "wss:"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw authorityError("INVALID_ARGUMENT");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw authorityError("INVALID_ARGUMENT");
  }
  if (
    parsed.protocol !== protocol
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw authorityError("INVALID_ARGUMENT");
  return parsed.toString();
}

function stateUrl(value: unknown, protocol: "https:" | "wss:"): string {
  try {
    return exactUrl(value, protocol);
  } catch {
    return invalidState();
  }
}

type FingerprintField = string | number | boolean | null;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fixedFieldFingerprint(
  fields: Readonly<Record<string, FingerprintField>>,
  orderedKeys: readonly string[],
): string {
  if (!isRecord(fields) || !hasExactKeys(fields, orderedKeys)) {
    throw authorityError("INVALID_ARGUMENT");
  }
  const normalized: Record<string, FingerprintField> = Object.create(null);
  for (const key of orderedKeys) {
    const value = fields[key];
    if (
      value !== null
      && typeof value !== "string"
      && typeof value !== "number"
      && typeof value !== "boolean"
    ) throw authorityError("INVALID_ARGUMENT");
    normalized[key] = value;
  }
  return sha256Hex(Buffer.from(JSON.stringify(normalized), "utf8"));
}

function strictlySortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  let previous: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (previous !== null && compareUtf8(previous, current) >= 0) return false;
    previous = current;
  }
  return true;
}

function strictlyIncreasingUint64<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  let previous: bigint | null = null;
  for (const value of values) {
    const current = BigInt(key(value));
    if (previous !== null && current <= previous) return false;
    previous = current;
  }
  return true;
}

function cloneEnvelope(value: CredentialAuthorityEnvelope): CredentialAuthorityEnvelope {
  return structuredClone(value);
}

function parseEnrollment(value: unknown): EnrollmentRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "enrollmentId",
    "hostId",
    "codeHash",
    "createdAtMs",
    "expiresAtMs",
    "failedAttempts",
    "consumedAtMs",
  ])) invalidState();
  if (
    !isRelayV2AuthIdentifier(value.enrollmentId)
    || !isRelayV2AuthIdentifier(value.hostId)
    || typeof value.codeHash !== "string"
    || !SHA256_HEX.test(value.codeHash)
    || !isTimestamp(value.createdAtMs)
    || !isTimestamp(value.expiresAtMs)
    || value.expiresAtMs <= value.createdAtMs
    || typeof value.failedAttempts !== "number"
    || !Number.isSafeInteger(value.failedAttempts)
    || value.failedAttempts < 0
    || value.failedAttempts > RELAY_V2_BROKER_CREDENTIAL_ENROLLMENT_MAX_FAILURES
    || (value.consumedAtMs !== null && !isTimestamp(value.consumedAtMs))
  ) invalidState();
  return {
    enrollmentId: value.enrollmentId,
    hostId: value.hostId,
    codeHash: value.codeHash,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    failedAttempts: value.failedAttempts as number,
    consumedAtMs: value.consumedAtMs as number | null,
  };
}

function parseHostBootstrap(
  value: unknown,
  lastObservedAtMs: number,
): HostBootstrapRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "selector",
    "tokenHash",
    "createdAtMs",
    "expiresAtMs",
    "failedAttempts",
    "terminalAtMs",
    "terminalReason",
  ])) invalidState();
  if (!isRelayV2AuthIdentifier(value.selector)) invalidState();
  exactBase64UrlBytes(value.selector, 16);
  if (
    typeof value.tokenHash !== "string"
    || !SHA256_HEX.test(value.tokenHash)
    || !isTimestamp(value.createdAtMs)
    || value.createdAtMs > lastObservedAtMs
    || !isTimestamp(value.expiresAtMs)
    || value.expiresAtMs <= value.createdAtMs
    || value.expiresAtMs > Number.MAX_SAFE_INTEGER
      - RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS
    || value.expiresAtMs - value.createdAtMs
      > RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS
    || typeof value.failedAttempts !== "number"
    || !Number.isSafeInteger(value.failedAttempts)
    || value.failedAttempts < 0
    || value.failedAttempts > RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES
    || (value.terminalAtMs !== null
      && (!isTimestamp(value.terminalAtMs)
        || value.terminalAtMs < value.createdAtMs
        || value.terminalAtMs >= value.expiresAtMs
        || value.terminalAtMs > lastObservedAtMs))
    || (value.terminalReason !== null
      && value.terminalReason !== "consumed"
      && value.terminalReason !== "failures_exhausted")
    || (value.terminalAtMs === null) !== (value.terminalReason === null)
    || (value.terminalReason === null
      && value.failedAttempts >= RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES)
    || (value.terminalReason === "consumed"
      && value.failedAttempts >= RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES)
    || (value.terminalReason === "failures_exhausted"
      && value.failedAttempts !== RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES)
  ) invalidState();
  return {
    selector: value.selector,
    tokenHash: value.tokenHash,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    failedAttempts: value.failedAttempts,
    terminalAtMs: value.terminalAtMs as number | null,
    terminalReason: value.terminalReason as HostBootstrapRecord["terminalReason"],
  };
}

function parseGrant(value: unknown): GrantRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "role",
    "hostId",
    "principalId",
    "grantId",
    "clientInstanceId",
    "refreshTokenHash",
    "credentialVersion",
    "refreshExpiresAtMs",
    "maxAccessExpiresAtMs",
    "revokedAtMs",
  ])) invalidState();
  if (
    (value.role !== "client" && value.role !== "host")
    || !isRelayV2AuthIdentifier(value.hostId)
    || !isRelayV2AuthIdentifier(value.principalId)
    || !isRelayV2AuthIdentifier(value.grantId)
    || (value.role === "client"
      ? !isRelayV2AuthIdentifier(value.clientInstanceId)
      : value.clientInstanceId !== null)
    || typeof value.refreshTokenHash !== "string"
    || !SHA256_HEX.test(value.refreshTokenHash)
    || !isCanonicalUint64(value.credentialVersion)
    || value.credentialVersion === "0"
    || !isTimestamp(value.refreshExpiresAtMs)
    || !isTimestamp(value.maxAccessExpiresAtMs)
    || (value.revokedAtMs !== null && !isTimestamp(value.revokedAtMs))
  ) invalidState();
  return {
    role: value.role,
    hostId: value.hostId,
    principalId: value.principalId,
    grantId: value.grantId,
    clientInstanceId: value.clientInstanceId as string | null,
    refreshTokenHash: value.refreshTokenHash,
    credentialVersion: value.credentialVersion,
    refreshExpiresAtMs: value.refreshExpiresAtMs,
    maxAccessExpiresAtMs: value.maxAccessExpiresAtMs,
    revokedAtMs: value.revokedAtMs as number | null,
  };
}

function parseReplay(
  value: unknown,
  legacyReplayKeyId?: string,
): ReplayRecord {
  const legacy = legacyReplayKeyId !== undefined;
  if (!isRecord(value) || !hasExactKeys(value, [
    "operation",
    "subjectId",
    "attemptId",
    "fingerprint",
    ...(legacy ? [] : ["replayKeyId", "aadVersion"]),
    "ciphertextBase64url",
    "expiresAtMs",
  ])) invalidState();
  if (
    ![
      "enrollment.create",
      "enrollment.redeem",
      "host.bootstrap",
      "grant.refresh",
      "host.reauthenticate",
      "grant.revoke",
    ].includes(value.operation as string)
    || !isRelayV2AuthIdentifier(value.subjectId)
    || !isRelayV2AuthIdentifier(value.attemptId)
    || typeof value.fingerprint !== "string"
    || !SHA256_HEX.test(value.fingerprint)
    || (!legacy && !isRelayV2AuthIdentifier(value.replayKeyId))
    || (!legacy && value.aadVersion !== 1 && value.aadVersion !== 2)
    || !isTimestamp(value.expiresAtMs)
  ) invalidState();
  const ciphertext = exactBase64UrlBytes(value.ciphertextBase64url);
  if (ciphertext.byteLength > MAX_REPLAY_CIPHERTEXT_BYTES) invalidState();
  return {
    operation: value.operation as ReplayOperation,
    subjectId: value.subjectId,
    attemptId: value.attemptId,
    fingerprint: value.fingerprint,
    replayKeyId: legacy ? legacyReplayKeyId! : value.replayKeyId as string,
    aadVersion: legacy ? 1 : value.aadVersion as 1 | 2,
    ciphertextBase64url: value.ciphertextBase64url as string,
    expiresAtMs: value.expiresAtMs,
  };
}

function replayKeyIdForLegacyKey(keyBase64url: string): string {
  return `replay-key-legacy-${sha256Hex(exactBase64UrlBytes(keyBase64url, 32))}`;
}

function replayKeyIdForGenesis(anchorId: string, commitId: string): string {
  return `replay-key-${sha256Hex(`genesis\u0000${anchorId}\u0000${commitId}`)}`;
}

function replayKeyIdForRotation(anchorId: string, rotationId: string): string {
  return `replay-key-${sha256Hex(`rotation\u0000${anchorId}\u0000${rotationId}`)}`;
}

function parseReplayKeyMaterial(value: unknown): ReplayKeyMaterial {
  if (!isRecord(value) || !hasExactKeys(value, [
    "replayKeyId",
    "keyBase64url",
    "legacyAad",
  ])) invalidState();
  if (
    !isRelayV2AuthIdentifier(value.replayKeyId)
    || typeof value.legacyAad !== "boolean"
  ) invalidState();
  exactBase64UrlBytes(value.keyBase64url, 32);
  return {
    replayKeyId: value.replayKeyId,
    keyBase64url: value.keyBase64url as string,
    legacyAad: value.legacyAad,
  };
}

function parseReplayKeyRotation(value: unknown): ReplayKeyRotationRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "rotationId",
    "replayKeyId",
    "commitSequence",
  ])) invalidState();
  if (
    !isRelayV2AuthIdentifier(value.rotationId)
    || !isRelayV2AuthIdentifier(value.replayKeyId)
    || !isCanonicalUint64(value.commitSequence)
    || value.commitSequence === "0"
  ) invalidState();
  return {
    rotationId: value.rotationId,
    replayKeyId: value.replayKeyId,
    commitSequence: value.commitSequence,
  };
}

function parseReplayKeyring(
  value: unknown,
  envelopeCommitSequence: string,
): ReplayKeyring {
  if (!isRecord(value) || !hasExactKeys(value, [
    "originKeyId",
    "activeKey",
    "decryptOnlyKeys",
    "rotations",
  ])) invalidState();
  if (
    !isRelayV2AuthIdentifier(value.originKeyId)
    || !Array.isArray(value.decryptOnlyKeys)
    || value.decryptOnlyKeys.length > MAX_REPLAY_DECRYPT_ONLY_KEYS
    || !Array.isArray(value.rotations)
    || value.rotations.length > MAX_REPLAY_KEY_ROTATIONS
  ) invalidState();
  const activeKey = parseReplayKeyMaterial(value.activeKey);
  const decryptOnlyKeys = value.decryptOnlyKeys.map(parseReplayKeyMaterial);
  const rotations = value.rotations.map(parseReplayKeyRotation);
  if (
    !strictlySortedUnique(decryptOnlyKeys, (item) => item.replayKeyId)
    || !strictlyIncreasingUint64(rotations, (item) => item.commitSequence)
  ) invalidState();
  const currentKeys = [activeKey, ...decryptOnlyKeys];
  const currentKeyIds = new Set(currentKeys.map((item) => item.replayKeyId));
  const currentKeySecrets = new Set(currentKeys.map((item) => item.keyBase64url));
  const rotationIds = new Set(rotations.map((item) => item.rotationId));
  const rotatedKeyIds = new Set(rotations.map((item) => item.replayKeyId));
  if (
    currentKeyIds.size !== currentKeys.length
    || currentKeySecrets.size !== currentKeys.length
    || rotationIds.size !== rotations.length
    || rotatedKeyIds.size !== rotations.length
    || rotatedKeyIds.has(value.originKeyId)
    || rotations.some((item) => BigInt(item.commitSequence) > BigInt(envelopeCommitSequence))
    || currentKeys.some((item) => (
      item.replayKeyId !== value.originKeyId && !rotatedKeyIds.has(item.replayKeyId)
    ))
    || currentKeys.filter((item) => item.legacyAad).some((item) => (
      item.replayKeyId !== value.originKeyId
    ))
  ) invalidState();
  const expectedActiveKeyId = rotations.length === 0
    ? value.originKeyId
    : rotations[rotations.length - 1]!.replayKeyId;
  if (activeKey.replayKeyId !== expectedActiveKeyId) invalidState();
  return {
    originKeyId: value.originKeyId,
    activeKey,
    decryptOnlyKeys,
    rotations,
  };
}

function parseRateLimit(value: unknown, lastObservedAtMs: number): RateLimitRecord {
  if (!isRecord(value) || !hasExactKeys(value, [
    "scope",
    "subjectHash",
    "windowStartedAtMs",
    "attempts",
  ])) invalidState();
  if (
    (value.scope !== "enrollment.redeem.source"
      && value.scope !== "host.bootstrap.source")
    || typeof value.subjectHash !== "string"
    || !SHA256_HEX.test(value.subjectHash)
    || !isTimestamp(value.windowStartedAtMs)
    || value.windowStartedAtMs > lastObservedAtMs
    || typeof value.attempts !== "number"
    || !Number.isSafeInteger(value.attempts)
    || value.attempts < 1
    || value.attempts > RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_MAX_ATTEMPTS
  ) invalidState();
  return {
    scope: value.scope,
    subjectHash: value.subjectHash,
    windowStartedAtMs: value.windowStartedAtMs,
    attempts: value.attempts as number,
  };
}

function parseEnvelope(bytes: Uint8Array, expectedAnchorId: string): CredentialAuthorityEnvelope {
  if (bytes.byteLength === 0 || bytes.byteLength > RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_MAX_BYTES) {
    return invalidState();
  }
  let value: unknown;
  try {
    value = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(bytes), {
      maxDepth: 8,
      maxKeys: 100_000,
      maxNodes: 160_000,
    });
  } catch {
    return invalidState();
  }
  const commonKeys = [
    "version",
    "anchorId",
    "commitSequence",
    "commitId",
    "parentCommitId",
    "lastObservedAtMs",
    "issuerUrl",
    "relayUrl",
    "issuer",
    "enrollments",
    "grants",
    "replays",
    "rateLimits",
  ] as const;
  if (!isRecord(value)) invalidState();
  const isLegacyEnvelope = value.version
    === RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_LEGACY_ENVELOPE_VERSION;
  const isHostBootstrapEnvelope = value.version
    === RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_HOST_BOOTSTRAP_ENVELOPE_VERSION;
  const isCurrentEnvelope = value.version
    === RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_ENVELOPE_VERSION;
  if (isLegacyEnvelope) {
    if (!hasExactKeys(value, [...commonKeys, "replayKeyBase64url"])) invalidState();
  } else if (isHostBootstrapEnvelope) {
    if (!hasExactKeys(value, [
      ...commonKeys,
      "replayKeyBase64url",
      "hostBootstraps",
    ])) invalidState();
  } else if (isCurrentEnvelope) {
    if (!hasExactKeys(value, [...commonKeys, "replayKeyring", "hostBootstraps"])) {
      invalidState();
    }
  } else {
    invalidState();
  }
  if (
    value.anchorId !== expectedAnchorId
    || !isRelayV2AuthIdentifier(value.anchorId)
    || !isCanonicalUint64(value.commitSequence)
    || !isRelayV2AuthIdentifier(value.commitId)
    || (value.parentCommitId !== null && !isRelayV2AuthIdentifier(value.parentCommitId))
    || (value.commitSequence === "0") !== (value.parentCommitId === null)
    || value.commitId === value.parentCommitId
    || !isTimestamp(value.lastObservedAtMs)
    || !Array.isArray(value.enrollments)
    || ((isHostBootstrapEnvelope || isCurrentEnvelope)
      && !Array.isArray(value.hostBootstraps))
    || !Array.isArray(value.grants)
    || !Array.isArray(value.replays)
    || !Array.isArray(value.rateLimits)
    || value.enrollments.length > MAX_ENROLLMENTS
    || ((isHostBootstrapEnvelope || isCurrentEnvelope)
      && value.hostBootstraps.length > MAX_HOST_BOOTSTRAPS)
    || value.grants.length > MAX_GRANTS
    || value.replays.length > MAX_REPLAYS
    || value.rateLimits.length > MAX_RATE_BUCKETS
  ) invalidState();
  let replayKeyring: ReplayKeyring;
  let legacyReplayKeyId: string | undefined;
  if (isCurrentEnvelope) {
    replayKeyring = parseReplayKeyring(value.replayKeyring, value.commitSequence);
  } else {
    const legacyKeyBase64url = value.replayKeyBase64url as string;
    exactBase64UrlBytes(legacyKeyBase64url, 32);
    legacyReplayKeyId = replayKeyIdForLegacyKey(legacyKeyBase64url);
    replayKeyring = {
      originKeyId: legacyReplayKeyId,
      activeKey: {
        replayKeyId: legacyReplayKeyId,
        keyBase64url: legacyKeyBase64url,
        legacyAad: true,
      },
      decryptOnlyKeys: [],
      rotations: [],
    };
  }
  let issuer: RelayV2IssuerKeyring;
  try {
    issuer = structuredClone(parseRelayV2IssuerKeyring(value.issuer));
  } catch {
    return invalidState();
  }
  const enrollments = value.enrollments.map(parseEnrollment);
  const hostBootstraps = isLegacyEnvelope
    ? []
    : value.hostBootstraps.map((record) => parseHostBootstrap(record, value.lastObservedAtMs));
  const grants = value.grants.map(parseGrant);
  const replays = value.replays.map((record) => parseReplay(record, legacyReplayKeyId));
  const rateLimits = value.rateLimits.map((record) => (
    parseRateLimit(record, value.lastObservedAtMs)
  ));
  if (
    isLegacyEnvelope
    && rateLimits.some((record) => record.scope === "host.bootstrap.source")
  ) invalidState();
  const hostBootstrapTokenHashes = new Set(hostBootstraps.map((item) => item.tokenHash));
  const replayKeysById = new Map([
    replayKeyring.activeKey,
    ...replayKeyring.decryptOnlyKeys,
  ].map((item) => [item.replayKeyId, item] as const));
  const referencedDecryptOnlyKeyIds = new Set<string>();
  for (const replay of replays) {
    const replayKey = replayKeysById.get(replay.replayKeyId);
    if (!replayKey || (replay.aadVersion === 1 && !replayKey.legacyAad)) invalidState();
    if (replay.replayKeyId !== replayKeyring.activeKey.replayKeyId) {
      referencedDecryptOnlyKeyIds.add(replay.replayKeyId);
    }
  }
  if (replayKeyring.decryptOnlyKeys.some((item) => (
    !referencedDecryptOnlyKeyIds.has(item.replayKeyId)
  ))) invalidState();
  const hostBootstrapReplayAttempts = new Set<string>();
  const hostBootstrapReplaysBySelector = new Map<string, ReplayRecord>();
  for (const replay of replays) {
    if (replay.operation !== "host.bootstrap") continue;
    exactBase64UrlBytes(replay.subjectId, 16);
    if (
      replay.expiresAtMs <= value.lastObservedAtMs
      || hostBootstrapReplayAttempts.has(replay.attemptId)
      || hostBootstrapReplaysBySelector.has(replay.subjectId)
    ) invalidState();
    hostBootstrapReplayAttempts.add(replay.attemptId);
    hostBootstrapReplaysBySelector.set(replay.subjectId, replay);
  }
  for (const bootstrap of hostBootstraps) {
    const replay = hostBootstrapReplaysBySelector.get(bootstrap.selector);
    if (bootstrap.terminalReason === "consumed") {
      if (
        !replay
        || bootstrap.terminalAtMs === null
        || replay.expiresAtMs !== bootstrap.terminalAtMs
          + RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS
      ) invalidState();
      hostBootstrapReplaysBySelector.delete(bootstrap.selector);
    } else if (replay) {
      invalidState();
    }
  }
  if (hostBootstrapReplaysBySelector.size !== 0) invalidState();
  if (
    !strictlySortedUnique(enrollments, (item) => item.enrollmentId)
    || !strictlySortedUnique(hostBootstraps, (item) => item.selector)
    || hostBootstrapTokenHashes.size !== hostBootstraps.length
    || !strictlySortedUnique(grants, (item) => item.grantId)
    || !strictlySortedUnique(replays, replayIdentity)
    || !strictlySortedUnique(rateLimits, rateLimitIdentity)
  ) invalidState();
  return {
    version: RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_ENVELOPE_VERSION,
    anchorId: value.anchorId,
    commitSequence: value.commitSequence,
    commitId: value.commitId,
    parentCommitId: value.parentCommitId as string | null,
    lastObservedAtMs: value.lastObservedAtMs,
    issuerUrl: stateUrl(value.issuerUrl, "https:"),
    relayUrl: stateUrl(value.relayUrl, "wss:"),
    replayKeyring,
    issuer,
    enrollments,
    hostBootstraps,
    grants,
    replays,
    rateLimits,
  };
}

function encodeEnvelope(value: CredentialAuthorityEnvelope): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_MAX_BYTES) {
    throw authorityError("STATE_CAPACITY_EXHAUSTED");
  }
  parseEnvelope(bytes, value.anchorId);
  return bytes;
}

function replayIdentity(value: ReplayRecord): string {
  return `${value.operation}\u0000${value.subjectId}\u0000${value.attemptId}`;
}

function rateLimitIdentity(value: RateLimitRecord): string {
  return `${value.scope}\u0000${value.subjectHash}`;
}

function checkpointForBytes(
  state: CredentialAuthorityEnvelope,
  bytes: Uint8Array,
): RelayV2ContinuityCheckpoint {
  return {
    protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    anchorId: state.anchorId,
    sequence: state.commitSequence,
    commitId: state.commitId,
    parentCommitId: state.parentCommitId,
    stateDigest: sha256Hex(bytes),
  };
}

function sameCheckpoint(
  left: RelayV2ContinuityCheckpoint,
  right: RelayV2ContinuityCheckpoint,
): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.anchorId === right.anchorId
    && left.sequence === right.sequence
    && left.commitId === right.commitId
    && left.parentCommitId === right.parentCommitId
    && left.stateDigest === right.stateDigest;
}

function structuredReject(
  code: RelayV2StructuredError["code"],
  message: string,
  retryable = false,
  retryAfterMs: number | null = null,
): RelayV2StructuredError {
  return {
    code,
    message,
    retryable,
    retryAfterMs,
    commandDisposition: "not_applicable",
    details: null,
  };
}

function carrierDecisionForAuthorityError(
  error: RelayV2BrokerCredentialAuthorityError,
): RelayV2AuthControlDecision {
  switch (error.code) {
    case "AUTH_INVALID":
      return { outcome: "reject", error: structuredReject("AUTH_INVALID", "Credential is invalid") };
    case "GRANT_NOT_FOUND":
      return { outcome: "reject", error: structuredReject("GRANT_NOT_FOUND", "Grant was not found") };
    case "ROLE_MISMATCH":
      return { outcome: "reject", error: structuredReject("ROLE_MISMATCH", "Credential role does not match") };
    case "PERMISSION_DENIED":
      return { outcome: "reject", error: structuredReject("PERMISSION_DENIED", "Operation is not permitted") };
    case "IDEMPOTENCY_CONFLICT":
      return {
        outcome: "reject",
        error: structuredReject("IDEMPOTENCY_CONFLICT", "Request conflicts with a prior attempt"),
      };
    case "BUSY":
    case "STATE_CAPACITY_EXHAUSTED":
      return {
        outcome: "reject",
        error: structuredReject("BUSY", "Credential authority is busy", true, 1_000),
      };
    case "AUTHORITY_NOT_READY":
    case "AUTHORITY_CLOSED":
    case "LIVE_AUTHORIZATION_FENCE_UNAVAILABLE":
      return {
        outcome: "reject",
        error: structuredReject(
          "CAPABILITY_UNAVAILABLE",
          "Persistent credential authority is unavailable",
        ),
      };
    case "INVALID_ARGUMENT":
      return {
        outcome: "reject",
        error: structuredReject("INVALID_ENVELOPE", "Credential control request is invalid"),
      };
    default:
      throw error;
  }
}

function rejectTransition<Result>(
  code: RelayV2BrokerCredentialAuthorityErrorCode,
  changed: boolean,
): TransitionResult<Result> {
  return { disposition: "reject", error: authorityError(code), changed };
}

function returnTransition<Result>(
  value: Result,
  changed: boolean,
  liveAuthorizationInvalidation?: RelayV2LiveAuthorizationInvalidation,
): TransitionResult<Result> {
  return {
    disposition: "return",
    value,
    changed,
    ...(liveAuthorizationInvalidation === undefined
      ? {}
      : { liveAuthorizationInvalidation }),
  };
}

function replayAad(
  record: Pick<
    ReplayRecord,
    "operation" | "subjectId" | "attemptId" | "fingerprint" | "replayKeyId" | "aadVersion"
  >,
): Buffer {
  const aad = {
    operation: record.operation,
    subjectId: record.subjectId,
    attemptId: record.attemptId,
    fingerprint: record.fingerprint,
    ...(record.aadVersion === 2 ? { replayKeyId: record.replayKeyId } : {}),
  };
  return Buffer.from(JSON.stringify(aad), "utf8");
}

function replayKeyFor(
  state: CredentialAuthorityEnvelope,
  replayKeyId: string,
): ReplayKeyMaterial {
  const replayKey = state.replayKeyring.activeKey.replayKeyId === replayKeyId
    ? state.replayKeyring.activeKey
    : state.replayKeyring.decryptOnlyKeys.find((item) => item.replayKeyId === replayKeyId);
  if (!replayKey) invalidState();
  return replayKey;
}

function sealReplayResponse(
  state: CredentialAuthorityEnvelope,
  record: Pick<
    ReplayRecord,
    "operation" | "subjectId" | "attemptId" | "fingerprint" | "replayKeyId" | "aadVersion"
  >,
  response: RelayV2JsonObject,
  random: (length: number) => Uint8Array,
): string {
  const plaintext = Buffer.from(JSON.stringify(response), "utf8");
  if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_REPLAY_PLAINTEXT_BYTES) {
    throw authorityError("STATE_CAPACITY_EXHAUSTED");
  }
  const key = exactBase64UrlBytes(
    replayKeyFor(state, record.replayKeyId).keyBase64url,
    32,
  );
  const iv = Buffer.from(random(12));
  if (iv.byteLength !== 12) throw authorityError("STATE_INVALID");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(replayAad(record));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function openReplayResponse(
  state: CredentialAuthorityEnvelope,
  record: ReplayRecord,
): RelayV2JsonObject {
  try {
    const sealed = exactBase64UrlBytes(record.ciphertextBase64url);
    if (sealed.byteLength < 29 || sealed.byteLength > MAX_REPLAY_CIPHERTEXT_BYTES) invalidState();
    const replayKey = replayKeyFor(state, record.replayKeyId);
    if (record.aadVersion === 1 && !replayKey.legacyAad) invalidState();
    const key = exactBase64UrlBytes(replayKey.keyBase64url, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    decipher.setAAD(replayAad(record));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_REPLAY_PLAINTEXT_BYTES) {
      invalidState();
    }
    const value = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(plaintext), {
      maxDepth: 8,
      maxKeys: 4_096,
      maxNodes: 8_192,
    });
    if (!isRecord(value)) invalidState();
    switch (record.operation) {
      case "enrollment.create":
        if (
          value.type !== "enrollment.created"
          || value.requestId !== record.attemptId
          || value.connectorId !== record.subjectId
        ) invalidState();
        break;
      case "enrollment.redeem":
        if (value.exchangeAttemptId !== record.attemptId) invalidState();
        break;
      case "host.bootstrap":
        if (value.bootstrapAttemptId !== record.attemptId) invalidState();
        break;
      case "grant.refresh":
        if (
          value.refreshAttemptId !== record.attemptId
          || value.grantId !== record.subjectId
        ) invalidState();
        break;
      case "host.reauthenticate":
        if (
          value.type !== "host.reauthenticated"
          || value.requestId !== record.attemptId
          || value.connectorId !== record.subjectId
        ) invalidState();
        break;
      case "grant.revoke":
        if (
          value.type !== "grant.revoked"
          || value.requestId !== record.attemptId
          || value.connectorId !== record.subjectId
        ) invalidState();
        break;
    }
    return value as RelayV2JsonObject;
  } catch (error) {
    if (error instanceof RelayV2BrokerCredentialAuthorityError) throw error;
    return invalidState();
  }
}

function replayFor(
  state: CredentialAuthorityEnvelope,
  operation: ReplayOperation,
  subjectId: string,
  attemptId: string,
): ReplayRecord | undefined {
  const identity = `${operation}\u0000${subjectId}\u0000${attemptId}`;
  return state.replays.find((record) => replayIdentity(record) === identity);
}

function replayForAttempt(
  state: CredentialAuthorityEnvelope,
  operation: ReplayOperation,
  attemptId: string,
): ReplayRecord | undefined {
  return state.replays.find((record) => (
    record.operation === operation && record.attemptId === attemptId
  ));
}

function addReplay(
  state: CredentialAuthorityEnvelope,
  record: Omit<
    ReplayRecord,
    "replayKeyId" | "aadVersion" | "ciphertextBase64url" | "expiresAtMs"
  >,
  response: RelayV2JsonObject,
  now: number,
  random: (length: number) => Uint8Array,
): void {
  if (state.replays.length >= MAX_REPLAYS) {
    throw authorityError("STATE_CAPACITY_EXHAUSTED");
  }
  const next: ReplayRecord = {
    ...record,
    replayKeyId: state.replayKeyring.activeKey.replayKeyId,
    aadVersion: 2,
    ciphertextBase64url: "",
    expiresAtMs: now + RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS,
  };
  if (!Number.isSafeInteger(next.expiresAtMs)) {
    throw authorityError("STATE_CAPACITY_EXHAUSTED");
  }
  next.ciphertextBase64url = sealReplayResponse(state, next, response, random);
  state.replays.push(next);
  state.replays.sort((left, right) => compareUtf8(replayIdentity(left), replayIdentity(right)));
}

function consumeSourceRateLimit(
  state: CredentialAuthorityEnvelope,
  endpoint: RelayV2BrokerCredentialHttpSourceEndpoint,
  subjectHash: string,
  now: number,
): boolean {
  const scope: RateLimitRecord["scope"] = (
    endpoint === "host_bootstrap" || endpoint === "host_refresh"
  )
    ? "host.bootstrap.source"
    : "enrollment.redeem.source";
  let record = state.rateLimits.find((candidate) => (
    candidate.scope === scope && candidate.subjectHash === subjectHash
  ));
  if (!record) {
    if (state.rateLimits.length >= MAX_RATE_BUCKETS) {
      throw authorityError("STATE_CAPACITY_EXHAUSTED");
    }
    record = {
      scope,
      subjectHash,
      windowStartedAtMs: now,
      attempts: 1,
    };
    state.rateLimits.push(record);
    state.rateLimits.sort((left, right) => (
      compareUtf8(rateLimitIdentity(left), rateLimitIdentity(right))
    ));
    return true;
  }
  if (now - record.windowStartedAtMs >= RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_WINDOW_MS) {
    record.windowStartedAtMs = now;
    record.attempts = 1;
    return true;
  }
  if (record.attempts >= RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_MAX_ATTEMPTS) return false;
  record.attempts += 1;
  return true;
}

function pruneExpiredAuthorityState(state: CredentialAuthorityEnvelope, now: number): boolean {
  let changed = false;
  const replays = state.replays.filter((record) => record.expiresAtMs > now);
  if (replays.length !== state.replays.length) {
    state.replays = replays;
    changed = true;
  }
  const referencedReplayKeyIds = new Set(state.replays.map((record) => record.replayKeyId));
  const decryptOnlyKeys = state.replayKeyring.decryptOnlyKeys.filter((key) => (
    referencedReplayKeyIds.has(key.replayKeyId)
  ));
  if (decryptOnlyKeys.length !== state.replayKeyring.decryptOnlyKeys.length) {
    state.replayKeyring.decryptOnlyKeys = decryptOnlyKeys;
    changed = true;
  }
  const rateLimits = state.rateLimits.filter((record) => (
    now - record.windowStartedAtMs < RELAY_V2_BROKER_CREDENTIAL_SOURCE_RATE_WINDOW_MS
  ));
  if (rateLimits.length !== state.rateLimits.length) {
    state.rateLimits = rateLimits;
    changed = true;
  }
  const enrollments = state.enrollments.filter((record) => {
    const terminalAt = record.consumedAtMs ?? record.expiresAtMs;
    return terminalAt + RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS > now;
  });
  if (enrollments.length !== state.enrollments.length) {
    state.enrollments = enrollments;
    changed = true;
  }
  const hostBootstraps = state.hostBootstraps.filter((record) => {
    const terminalAt = record.terminalAtMs ?? record.expiresAtMs;
    return terminalAt + RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS > now;
  });
  if (hostBootstraps.length !== state.hostBootstraps.length) {
    state.hostBootstraps = hostBootstraps;
    changed = true;
  }
  const grantRetentionMs = RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS;
  const clockSkewMs = RELAY_V2_MAX_CLOCK_SKEW_SECONDS * 1_000;
  const grants = state.grants.filter((grant) => {
    if (grant.maxAccessExpiresAtMs > Number.MAX_SAFE_INTEGER - clockSkewMs) return true;
    const accessSafeAtMs = grant.maxAccessExpiresAtMs + clockSkewMs;
    const terminalAtMs = Math.max(
      grant.refreshExpiresAtMs,
      accessSafeAtMs,
      grant.revokedAtMs ?? 0,
    );
    if (terminalAtMs > Number.MAX_SAFE_INTEGER - grantRetentionMs) return true;
    return terminalAtMs + grantRetentionMs > now;
  });
  if (grants.length !== state.grants.length) {
    state.grants = grants;
    changed = true;
  }
  return changed;
}

function asGrantBinding(grant: GrantRecord): RelayV2GrantBinding {
  return {
    role: grant.role,
    hostId: grant.hostId,
    principalId: grant.principalId,
    grantId: grant.grantId,
    clientInstanceId: grant.clientInstanceId,
    revokedAtSeconds: grant.revokedAtMs === null ? null : Math.floor(grant.revokedAtMs / 1_000),
    expiresAtSeconds: Math.floor(grant.refreshExpiresAtMs / 1_000),
  };
}

function ensureIdentifier(value: unknown): string {
  if (!isRelayV2AuthIdentifier(value)) throw authorityError("INVALID_ARGUMENT");
  return value;
}

function credentialInput(value: unknown, prefix: "twenroll2" | "twref2"): string {
  if (typeof value !== "string") throw authorityError("INVALID_ARGUMENT");
  if (
    !value.startsWith(`${prefix}.`)
    || Buffer.byteLength(value, "utf8") > 512
    || value.includes("\0")
  ) throw authorityError("AUTH_INVALID");
  return value;
}

function hostBootstrapCredentialInput(value: unknown): {
  selector: string;
  tokenHash: string;
} {
  if (typeof value !== "string") throw authorityError("INVALID_ARGUMENT");
  if (Buffer.byteLength(value, "utf8") > 512 || value.includes("\0")) {
    throw authorityError("AUTH_INVALID");
  }
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "twhostboot2") {
    throw authorityError("AUTH_INVALID");
  }
  const [, selector, secret] = parts;
  if (!CANONICAL_BASE64URL.test(selector) || !CANONICAL_BASE64URL.test(secret)) {
    throw authorityError("AUTH_INVALID");
  }
  const selectorBytes = Buffer.from(selector, "base64url");
  const secretBytes = Buffer.from(secret, "base64url");
  if (
    selectorBytes.byteLength !== 16
    || selectorBytes.toString("base64url") !== selector
    || secretBytes.byteLength !== 32
    || secretBytes.toString("base64url") !== secret
  ) throw authorityError("AUTH_INVALID");
  return { selector, tokenHash: sha256Hex(value) };
}

function accessTokenInput(value: unknown): string {
  if (typeof value !== "string") throw authorityError("INVALID_ARGUMENT");
  if (
    !value.startsWith("twcap2.")
    || Buffer.byteLength(value, "utf8") > MAX_ACCESS_TOKEN_BYTES
    || value.includes("\0")
  ) throw authorityError("AUTH_INVALID");
  return value;
}

function generatedSecret(prefix: string, bytes: Uint8Array): string {
  if (bytes.byteLength < 16) throw authorityError("STATE_INVALID");
  return `${prefix}.${Buffer.from(bytes).toString("base64url")}`;
}

function generatedHostBootstrapToken(selector: Uint8Array, secret: Uint8Array): string {
  if (selector.byteLength !== 16 || secret.byteLength !== 32) {
    throw authorityError("STATE_INVALID");
  }
  return `twhostboot2.${Buffer.from(selector).toString("base64url")}.${Buffer.from(secret).toString("base64url")}`;
}

function stateCredentialSecret(
  value: unknown,
  prefix: "twcap2" | "twref2" | "twenroll2",
): string {
  const maxBytes = prefix === "twcap2" ? 8_192 : 512;
  if (
    typeof value !== "string"
    || !value.startsWith(`${prefix}.`)
    || Buffer.byteLength(value, "utf8") > maxBytes
    || value.includes("\0")
  ) invalidState();
  return value;
}

function enrollmentCreatedFrame(input: {
  requestId: string;
  connectorId: string;
  enrollmentId: string;
  enrollmentCode: string;
  hostId: string;
  issuerUrl: string;
  relayUrl: string;
  expiresAtMs: number;
  deduplicated?: boolean;
}): RelayV2JsonObject {
  return {
    carrierVersion: 1,
    type: "enrollment.created",
    requestId: input.requestId,
    connectorId: input.connectorId,
    payload: {
      deduplicated: input.deduplicated ?? false,
      enrollmentId: input.enrollmentId,
      enrollmentCode: input.enrollmentCode,
      hostId: input.hostId,
      issuerUrl: input.issuerUrl,
      relayUrl: input.relayUrl,
      expiresAtMs: input.expiresAtMs,
    },
  };
}

function enrollmentCreatedFromFrame(
  frame: RelayV2JsonObject,
  deduplicated: boolean,
  expected: { requestId: string; connectorId: string },
): RelayV2BrokerCredentialEnrollmentCreated {
  if (!isRecord(frame) || !hasExactKeys(frame, [
    "carrierVersion", "type", "requestId", "connectorId", "payload",
  ])) invalidState();
  if (
    frame.carrierVersion !== 1
    || frame.type !== "enrollment.created"
    || frame.requestId !== expected.requestId
    || frame.connectorId !== expected.connectorId
    || !isRecord(frame.payload)
    || !hasExactKeys(frame.payload, [
      "deduplicated",
      "enrollmentId",
      "enrollmentCode",
      "hostId",
      "issuerUrl",
      "relayUrl",
      "expiresAtMs",
    ])
    || frame.payload.deduplicated !== false
    || !isRelayV2AuthIdentifier(frame.payload.enrollmentId)
    || !isRelayV2AuthIdentifier(frame.payload.hostId)
    || !isTimestamp(frame.payload.expiresAtMs)
  ) invalidState();
  const enrollmentCode = stateCredentialSecret(frame.payload.enrollmentCode, "twenroll2");
  return {
    enrollmentId: frame.payload.enrollmentId,
    enrollmentCode,
    hostId: frame.payload.hostId,
    issuerUrl: stateUrl(frame.payload.issuerUrl, "https:"),
    relayUrl: stateUrl(frame.payload.relayUrl, "wss:"),
    expiresAtMs: frame.payload.expiresAtMs,
    deduplicated,
  };
}

function grantRevokedFrame(input: {
  requestId: string;
  connectorId: string;
  grantId: string;
  revokedAtMs: number;
  alreadyRevoked: boolean;
}): RelayV2JsonObject {
  return {
    carrierVersion: 1,
    type: "grant.revoked",
    requestId: input.requestId,
    connectorId: input.connectorId,
    payload: {
      grantId: input.grantId,
      revokedAtMs: input.revokedAtMs,
      alreadyRevoked: input.alreadyRevoked,
    },
  };
}

function grantRevokedFromFrame(
  frame: RelayV2JsonObject,
  expected: { requestId: string; connectorId: string },
): RelayV2JsonObject {
  if (
    !isRecord(frame)
    || !hasExactKeys(frame, [
      "carrierVersion", "type", "requestId", "connectorId", "payload",
    ])
    || frame.carrierVersion !== 1
    || frame.type !== "grant.revoked"
    || frame.requestId !== expected.requestId
    || frame.connectorId !== expected.connectorId
    || !isRecord(frame.payload)
    || !hasExactKeys(frame.payload, ["grantId", "revokedAtMs", "alreadyRevoked"])
    || !isRelayV2AuthIdentifier(frame.payload.grantId)
    || !isTimestamp(frame.payload.revokedAtMs)
    || typeof frame.payload.alreadyRevoked !== "boolean"
  ) invalidState();
  return grantRevokedFrame({
    requestId: expected.requestId,
    connectorId: expected.connectorId,
    grantId: frame.payload.grantId,
    revokedAtMs: frame.payload.revokedAtMs,
    alreadyRevoked: frame.payload.alreadyRevoked,
  });
}

function hostReauthenticatedFrame(input: {
  requestId: string;
  connectorId: string;
  grantId: string;
  jti: string;
  expiresAtMs: number;
}): RelayV2JsonObject {
  return {
    carrierVersion: 1,
    type: "host.reauthenticated",
    requestId: input.requestId,
    connectorId: input.connectorId,
    payload: {
      grantId: input.grantId,
      jti: input.jti,
      expiresAtMs: input.expiresAtMs,
      deduplicated: false,
    },
  };
}

function hostReauthenticatedFromFrame(
  frame: RelayV2JsonObject,
  deduplicated: boolean,
  expected: { requestId: string; connectorId: string },
): RelayV2JsonObject {
  if (!isRecord(frame) || !hasExactKeys(frame, [
    "carrierVersion", "type", "requestId", "connectorId", "payload",
  ])) invalidState();
  if (
    frame.carrierVersion !== 1
    || frame.type !== "host.reauthenticated"
    || frame.requestId !== expected.requestId
    || frame.connectorId !== expected.connectorId
    || !isRecord(frame.payload)
    || !hasExactKeys(frame.payload, ["grantId", "jti", "expiresAtMs", "deduplicated"])
    || !isRelayV2AuthIdentifier(frame.payload.grantId)
    || !isRelayV2AuthIdentifier(frame.payload.jti)
    || !isTimestamp(frame.payload.expiresAtMs)
    || frame.payload.deduplicated !== false
  ) invalidState();
  return {
    carrierVersion: 1,
    type: "host.reauthenticated",
    requestId: frame.requestId,
    connectorId: frame.connectorId,
    payload: {
      grantId: frame.payload.grantId,
      jti: frame.payload.jti,
      expiresAtMs: frame.payload.expiresAtMs,
      deduplicated,
    },
  };
}

type GrantCredentialResponseExpectation =
  | { endpoint: "enrollment_redeem"; attemptId: string }
  | { endpoint: "client_refresh"; attemptId: string }
  | { endpoint: "host_bootstrap"; attemptId: string }
  | { endpoint: "host_refresh"; attemptId: string };

function grantCredentialFromResponse(
  response: RelayV2JsonObject,
  replayed: boolean,
  expected: GrantCredentialResponseExpectation,
): RelayV2BrokerCredentialGrantCredential {
  if (!isRecord(response)) invalidState();
  const commonKeys = [
    "principalId",
    "grantId",
    "hostId",
    "accessToken",
    "accessExpiresAtMs",
    "refreshToken",
    "refreshExpiresAtMs",
  ] as const;
  const validShape = expected.endpoint === "enrollment_redeem"
    ? hasExactKeys(response, ["exchangeAttemptId", ...commonKeys, "relayUrl"])
      && response.exchangeAttemptId === expected.attemptId
    : expected.endpoint === "client_refresh"
      ? hasExactKeys(response, ["refreshAttemptId", ...commonKeys, "relayUrl"])
        && response.refreshAttemptId === expected.attemptId
      : expected.endpoint === "host_bootstrap"
        ? hasExactKeys(response, ["bootstrapAttemptId", ...commonKeys])
          && response.bootstrapAttemptId === expected.attemptId
        : hasExactKeys(response, ["refreshAttemptId", ...commonKeys])
          && response.refreshAttemptId === expected.attemptId;
  if (
    !validShape
    || !isRelayV2AuthIdentifier(response.principalId)
    || !isRelayV2AuthIdentifier(response.grantId)
    || !isRelayV2AuthIdentifier(response.hostId)
    || !isTimestamp(response.accessExpiresAtMs)
    || !isTimestamp(response.refreshExpiresAtMs)
  ) invalidState();
  const common = {
    principalId: response.principalId,
    grantId: response.grantId,
    hostId: response.hostId,
    accessToken: stateCredentialSecret(response.accessToken, "twcap2"),
    accessExpiresAtMs: response.accessExpiresAtMs,
    refreshToken: stateCredentialSecret(response.refreshToken, "twref2"),
    refreshExpiresAtMs: response.refreshExpiresAtMs,
  };
  if (expected.endpoint === "enrollment_redeem") {
    const body = Object.freeze({
      exchangeAttemptId: expected.attemptId,
      ...common,
      relayUrl: stateUrl(response.relayUrl, "wss:"),
    });
    return Object.freeze({ endpoint: "enrollment_redeem", body, replayed });
  }
  if (expected.endpoint === "client_refresh") {
    const body = Object.freeze({
      refreshAttemptId: expected.attemptId,
      ...common,
      relayUrl: stateUrl(response.relayUrl, "wss:"),
    });
    return Object.freeze({ endpoint: "client_refresh", body, replayed });
  }
  if (expected.endpoint === "host_bootstrap") {
    const body = Object.freeze({ bootstrapAttemptId: expected.attemptId, ...common });
    return Object.freeze({ endpoint: "host_bootstrap", body, replayed });
  }
  const body = Object.freeze({ refreshAttemptId: expected.attemptId, ...common });
  return Object.freeze({ endpoint: "host_refresh", body, replayed });
}

function revalidateCurrentAuthContext(
  state: CredentialAuthorityEnvelope,
  context: Readonly<RelayV2BrokerConnectionAuthorization>,
  now: number,
  expectedRole: RelayV2AccessRole,
  options: Readonly<{ allowRevoked?: boolean }> = {},
): GrantRecord {
  if (!isRecord(context) || !hasExactKeys(context, [
    "scheme",
    "role",
    "hostId",
    "principalId",
    "grantId",
    "clientInstanceId",
    "jti",
    "kid",
    "expiresAtMs",
    "authorizationRevision",
    "authorizationFence",
  ])) throw authorityError("AUTH_INVALID");
  if (
    context.scheme !== "twcap2"
    || (context.role !== "client" && context.role !== "host")
    || !isRelayV2AuthIdentifier(context.hostId)
    || !isRelayV2AuthIdentifier(context.principalId)
    || !isRelayV2AuthIdentifier(context.grantId)
    || !isRelayV2AuthIdentifier(context.jti)
    || !isRelayV2AuthIdentifier(context.kid)
    || !isTimestamp(context.expiresAtMs)
    || context.expiresAtMs <= now
    || !isCanonicalUint64(context.authorizationRevision)
    || !isRelayV2AuthIdentifier(context.authorizationFence)
    || BigInt(context.authorizationRevision) > BigInt(state.commitSequence)
    || (context.authorizationRevision === state.commitSequence
      && context.authorizationFence !== state.commitId)
    || (context.role === "client"
      ? !isRelayV2AuthIdentifier(context.clientInstanceId)
      : context.clientInstanceId !== null)
    || (state.issuer.activeKey.kid !== context.kid
      && !state.issuer.verifyOnlyKeys.some((key) => key.kid === context.kid))
  ) throw authorityError("AUTH_INVALID");
  if (context.role !== expectedRole) throw authorityError("ROLE_MISMATCH");
  const grant = state.grants.find((candidate) => candidate.grantId === context.grantId);
  if (!grant) throw authorityError("GRANT_NOT_FOUND");
  if (grant.role !== context.role) throw authorityError("ROLE_MISMATCH");
  if (
    (!options.allowRevoked && grant.revokedAtMs !== null)
    || grant.refreshExpiresAtMs <= now
    || grant.hostId !== context.hostId
    || grant.principalId !== context.principalId
    || grant.clientInstanceId !== context.clientInstanceId
  ) throw authorityError("PERMISSION_DENIED");
  return grant;
}

function verifyAuthorizedAccessToken(
  state: CredentialAuthorityEnvelope,
  token: string,
  expectedRole: RelayV2AccessRole,
  now: number,
): RelayV2AuthContext {
  let claims;
  try {
    claims = verifyRelayV2IssuerAccessToken(token, state.issuer, {
      nowSeconds: Math.floor(now / 1_000),
    });
  } catch {
    throw authorityError("AUTH_INVALID");
  }
  const grant = state.grants.find((candidate) => candidate.grantId === claims.grantId);
  try {
    return verifyRelayV2AccessAuthorization(token, {
      keyring: state.issuer,
      grant: grant ? asGrantBinding(grant) : undefined,
      nowSeconds: Math.floor(now / 1_000),
      expectedRole,
    });
  } catch (error) {
    if (error instanceof RelayV2AuthError) throw authorityError(error.code);
    throw authorityError("AUTH_INVALID");
  }
}

function bindConnectionAuthorization(
  state: CredentialAuthorityEnvelope,
  context: Readonly<RelayV2AuthContext>,
): RelayV2BrokerConnectionAuthorization {
  return Object.freeze({
    scheme: context.scheme,
    role: context.role,
    hostId: context.hostId,
    principalId: context.principalId,
    grantId: context.grantId,
    clientInstanceId: context.clientInstanceId,
    jti: context.jti,
    kid: context.kid,
    expiresAtMs: context.expiresAtMs,
    authorizationRevision: state.commitSequence,
    authorizationFence: state.commitId,
  });
}

function sourceIdentityHash(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 512
  ) throw authorityError("INVALID_ARGUMENT");
  return sha256Hex(value);
}

function validateGenesis(
  genesis: RelayV2BrokerCredentialAuthorityGenesis,
): RelayV2BrokerCredentialAuthorityGenesis {
  if (!isRecord(genesis) || !hasExactKeys(genesis, [
    "issuerKeyring",
    "issuerUrl",
    "relayUrl",
  ])) throw authorityError("INVALID_ARGUMENT");
  let issuerKeyring: RelayV2IssuerKeyring;
  try {
    issuerKeyring = structuredClone(parseRelayV2IssuerKeyring(genesis.issuerKeyring));
  } catch {
    throw authorityError("INVALID_ARGUMENT");
  }
  return {
    issuerKeyring,
    issuerUrl: exactUrl(genesis.issuerUrl, "https:"),
    relayUrl: exactUrl(genesis.relayUrl, "wss:"),
  };
}

function mapFatalAuthorityError(
  error: unknown,
  flags: {
    storePublicationUncertain: boolean;
    definiteStateConflict: boolean;
    definiteStateInvalid: boolean;
  },
): RelayV2BrokerCredentialAuthorityError {
  if (flags.storePublicationUncertain) return authorityError("STORE_PUBLICATION_UNCERTAIN");
  if (flags.definiteStateConflict) return authorityError("STATE_CONFLICT");
  if (flags.definiteStateInvalid) return authorityError("STATE_INVALID");
  if (error instanceof RelayV2BrokerCredentialAuthorityError) return error;
  if (error instanceof RelayV2ContinuityAnchorError) {
    if (error.code === "STATE_COMMIT_UNCERTAIN") {
      return authorityError("STORE_PUBLICATION_UNCERTAIN");
    }
    if (error.code === "ANCHOR_COMMIT_UNCERTAIN") {
      return authorityError("EXTERNAL_ANCHOR_UNCERTAIN");
    }
    if (error.code === "ANCHOR_UNAVAILABLE" || error.code === "BUSY") {
      return authorityError("EXTERNAL_CONTINUITY_UNAVAILABLE");
    }
    if (error.code === "LOCAL_STATE_CONFLICT") return authorityError("STATE_CONFLICT");
    if (error.code === "CAS_CONFLICT") return authorityError("EXTERNAL_ANCHOR_CONFLICT");
    return authorityError("EXTERNAL_CONTINUITY_INVALID");
  }
  if (error instanceof RelayV2BrokerCredentialStateStoreError) {
    return error.code === "STORE_CLOSED"
      ? authorityError("AUTHORITY_CLOSED")
      : authorityError("STATE_INVALID");
  }
  return authorityError("STATE_INVALID");
}

function isReadDomainError(
  error: unknown,
): error is RelayV2BrokerCredentialAuthorityError {
  return error instanceof RelayV2BrokerCredentialAuthorityError
    && [
      "AUTH_INVALID",
      "ROLE_MISMATCH",
      "PERMISSION_DENIED",
      "GRANT_NOT_FOUND",
      "INVALID_ARGUMENT",
    ].includes(error.code);
}

/**
 * The sole durable business owner for Relay v2 broker credentials.
 *
 * It never observes filesystem identity, native generations, paths, digests,
 * or handles. The injected N0 store carries only opaque bytes and revisions;
 * the versioned envelope and all credential transitions remain private here.
 */
export class RelayV2BrokerCredentialAuthority
implements RelayV2BrokerAuthControlAuthority {
  private readonly store: RelayV2BrokerCredentialStateStore;
  private readonly continuity: RelayV2ContinuityAnchor;
  private readonly anchorId: string;
  private readonly genesis: RelayV2BrokerCredentialAuthorityGenesis;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly random: (length: number) => Uint8Array;
  private readonly liveAuthorizationFence: RelayV2LiveAuthorizationFencePort | undefined;
  private readonly sourceAdmissions = new Map<object, SourceAdmissionRecord>();
  private authorityContinuityReadinessValue:
    RelayV2BrokerCredentialAuthorityContinuityReadiness = { status: "opening" };
  private currentCheckpoint: RelayV2ContinuityCheckpoint | null = null;
  private closePromise: Promise<void> | null = null;

  private constructor(options: RelayV2BrokerCredentialAuthorityOptions) {
    if (!isRecord(options) || !hasExactKeys(options, [
      "store",
      "continuityAnchor",
      "genesis",
      ...(Object.hasOwn(options, "now") ? ["now"] : []),
      ...(Object.hasOwn(options, "randomId") ? ["randomId"] : []),
      ...(Object.hasOwn(options, "randomBytes") ? ["randomBytes"] : []),
      ...(Object.hasOwn(options, "liveAuthorizationFence") ? ["liveAuthorizationFence"] : []),
    ])) throw authorityError("INVALID_ARGUMENT");
    const installedLiveAuthorizationFence = options.liveAuthorizationFence === undefined
      ? undefined
      : cloneLiveAuthorizationFencePort(options.liveAuthorizationFence);
    if (
      !isRecord(options.store)
      || typeof options.store.runExclusive !== "function"
      || typeof options.store.close !== "function"
      || !isRecord(options.continuityAnchor)
      || !isRelayV2AuthIdentifier(options.continuityAnchor.anchorId)
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.randomId !== undefined && typeof options.randomId !== "function")
      || (options.randomBytes !== undefined && typeof options.randomBytes !== "function")
      || (options.liveAuthorizationFence !== undefined
        && installedLiveAuthorizationFence === undefined)
    ) throw authorityError("INVALID_ARGUMENT");
    this.store = options.store;
    this.anchorId = options.continuityAnchor.anchorId;
    this.genesis = validateGenesis(options.genesis);
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.random = options.randomBytes ?? ((length) => systemRandomBytes(length));
    this.liveAuthorizationFence = installedLiveAuthorizationFence;
    try {
      this.continuity = new RelayV2ContinuityAnchor(options.continuityAnchor);
    } catch {
      throw authorityError("INVALID_ARGUMENT");
    }
  }

  static async open(
    options: RelayV2BrokerCredentialAuthorityOptions,
  ): Promise<RelayV2BrokerCredentialAuthority> {
    let candidateStore: unknown;
    try {
      candidateStore = isRecord(options) ? options.store : null;
    } catch {
      throw authorityError("INVALID_ARGUMENT");
    }
    const transferredStore = isRecord(candidateStore)
      && typeof candidateStore.runExclusive === "function"
      && typeof candidateStore.close === "function"
      ? candidateStore as unknown as RelayV2BrokerCredentialStateStore
      : null;
    if (transferredStore === null) throw authorityError("INVALID_ARGUMENT");
    let authority: RelayV2BrokerCredentialAuthority | null = null;
    try {
      authority = new RelayV2BrokerCredentialAuthority(options);
      await authority.initialize();
      authority.setAuthorityContinuityReadiness({ status: "ready" });
      return authority;
    } catch (error) {
      const mapped = mapFatalAuthorityError(error, {
        storePublicationUncertain: error instanceof RelayV2BrokerCredentialAuthorityError
          && error.code === "STORE_PUBLICATION_UNCERTAIN",
        definiteStateConflict: error instanceof RelayV2BrokerCredentialAuthorityError
          && error.code === "STATE_CONFLICT",
        definiteStateInvalid: error instanceof RelayV2BrokerCredentialAuthorityError
          && error.code === "STATE_INVALID",
      });
      if (authority !== null) return await authority.withdrawAndClose(mapped);
      try {
        await transferredStore.close();
      } catch {
        throw new RelayV2BrokerCredentialAuthorityError("CLOSE_BARRIER_FAILED", mapped.code);
      }
      throw mapped;
    }
  }

  /**
   * Readiness only for this authority's local-state/external-continuity gate.
   * It does not imply a native loader, packaged artifact, Relay capability,
   * HTTP endpoint, broker composition, or production readiness.
   */
  get authorityContinuityReadiness(): RelayV2BrokerCredentialAuthorityContinuityReadiness {
    return Object.freeze({ ...this.authorityContinuityReadinessValue });
  }

  close(): Promise<void> {
    const priorReason = this.authorityContinuityReadinessValue.status === "withdrawn"
      ? this.authorityContinuityReadinessValue.reason
      : "close_requested";
    this.withdrawAdmission(priorReason);
    return this.beginCloseBarrier(priorReason);
  }

  private setAuthorityContinuityReadiness(
    readiness: RelayV2BrokerCredentialAuthorityContinuityReadiness,
  ): void {
    this.authorityContinuityReadinessValue = Object.freeze({ ...readiness });
  }

  private withdrawAdmission(reason: RelayV2BrokerCredentialAuthorityWithdrawalReason): void {
    if (this.authorityContinuityReadinessValue.status === "closed") return;
    const firstWithdrawal = this.authorityContinuityReadinessValue.status !== "withdrawn";
    const retainedReason = this.authorityContinuityReadinessValue.status === "withdrawn"
      ? this.authorityContinuityReadinessValue.reason
      : reason;
    this.sourceAdmissions.clear();
    this.setAuthorityContinuityReadiness({ status: "withdrawn", reason: retainedReason });
    if (firstWithdrawal && this.liveAuthorizationFence) {
      try {
        this.liveAuthorizationFence.failClosed();
      } catch {
        // Broker notification follows the authority's own synchronous
        // withdrawal. An injected owner can never reopen this authority.
      }
    }
  }

  private beginCloseBarrier(
    reason: RelayV2BrokerCredentialAuthorityWithdrawalReason,
  ): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    let closeResult: Promise<void>;
    try {
      closeResult = Promise.resolve(this.store.close());
    } catch {
      closeResult = Promise.reject(new Error("close barrier failed"));
    }
    this.closePromise = closeResult.then(
      () => {
        this.setAuthorityContinuityReadiness({ status: "closed", reason });
      },
      () => {
        // A failed barrier is not a closed store. Admission remains withdrawn.
        throw new RelayV2BrokerCredentialAuthorityError("CLOSE_BARRIER_FAILED", reason);
      },
    );
    return this.closePromise;
  }

  private async withdrawAndClose(
    cause: RelayV2BrokerCredentialAuthorityError,
  ): Promise<never> {
    const reason = this.authorityContinuityReadinessValue.status === "withdrawn"
      ? this.authorityContinuityReadinessValue.reason
      : cause.code;
    this.withdrawAdmission(reason);
    await this.beginCloseBarrier(reason);
    throw cause;
  }

  private assertReady(): void {
    if (this.authorityContinuityReadinessValue.status === "closed") {
      throw authorityError("AUTHORITY_CLOSED");
    }
    if (this.authorityContinuityReadinessValue.status !== "ready") {
      throw authorityError("AUTHORITY_NOT_READY");
    }
  }

  private observedNow(previous: number): number {
    const observed = this.now();
    if (!isTimestamp(observed)) throw authorityError("STATE_INVALID");
    return Math.max(previous, observed);
  }

  private generatedId(): string {
    const generated = this.randomId();
    if (!isRelayV2AuthIdentifier(generated)) throw authorityError("STATE_INVALID");
    return generated;
  }

  private randomExact(length: number): Uint8Array {
    const generated = this.random(length);
    if (!(generated instanceof Uint8Array) || generated.byteLength !== length) {
      throw authorityError("STATE_INVALID");
    }
    return Uint8Array.from(generated);
  }

  private freshEnvelope(): CredentialAuthorityEnvelope {
    const now = this.observedNow(0);
    const replayKeyBase64url = Buffer.from(this.randomExact(32)).toString("base64url");
    const commitId = this.generatedId();
    const replayKeyId = replayKeyIdForGenesis(this.anchorId, commitId);
    return {
      version: RELAY_V2_BROKER_CREDENTIAL_AUTHORITY_ENVELOPE_VERSION,
      anchorId: this.anchorId,
      commitSequence: "0",
      commitId,
      parentCommitId: null,
      lastObservedAtMs: now,
      issuerUrl: this.genesis.issuerUrl,
      relayUrl: this.genesis.relayUrl,
      replayKeyring: {
        originKeyId: replayKeyId,
        activeKey: {
          replayKeyId,
          keyBase64url: replayKeyBase64url,
          legacyAad: false,
        },
        decryptOnlyKeys: [],
        rotations: [],
      },
      issuer: structuredClone(this.genesis.issuerKeyring),
      enrollments: [],
      hostBootstraps: [],
      grants: [],
      replays: [],
      rateLimits: [],
    };
  }

  private async initialize(): Promise<void> {
    const flags = {
      storePublicationUncertain: false,
      definiteStateConflict: false,
      definiteStateInvalid: false,
    };
    try {
      await this.store.runExclusive(async (transaction) => {
        const initial = await transaction.read();
        let state: CredentialAuthorityEnvelope;
        let bytes: Uint8Array;
        if (initial.outcome === "missing") {
          const genesis = this.freshEnvelope();
          const candidate = encodeEnvelope(genesis);
          let published;
          try {
            published = await transaction.compareAndPublish(initial.revision, candidate);
          } catch (error) {
            flags.storePublicationUncertain = true;
            throw error;
          }
          if (published.outcome === "uncertain") {
            flags.storePublicationUncertain = true;
            throw authorityError("STORE_PUBLICATION_UNCERTAIN");
          }
          if (published.outcome === "conflict") {
            flags.definiteStateConflict = true;
            throw authorityError("STATE_CONFLICT");
          } else {
            if (published.current.outcome !== "present") {
              flags.storePublicationUncertain = true;
              throw authorityError("STORE_PUBLICATION_UNCERTAIN");
            }
            try {
              state = parseEnvelope(published.current.bytes, this.anchorId);
              bytes = published.current.bytes;
            } catch (error) {
              flags.storePublicationUncertain = true;
              throw error;
            }
            if (!Buffer.from(bytes).equals(Buffer.from(candidate))) {
              flags.storePublicationUncertain = true;
              throw authorityError("STORE_PUBLICATION_UNCERTAIN");
            }
          }
        } else {
          state = parseEnvelope(initial.bytes, this.anchorId);
          bytes = initial.bytes;
        }
        if (
          state.issuer.issuerId !== this.genesis.issuerKeyring.issuerId
          || state.issuerUrl !== this.genesis.issuerUrl
          || state.relayUrl !== this.genesis.relayUrl
        ) throw authorityError("STATE_INVALID");
        const checkpoint = checkpointForBytes(state, bytes);
        await this.continuity.reconcile(checkpoint);
        this.currentCheckpoint = checkpoint;
      });
    } catch (error) {
      throw mapFatalAuthorityError(error, flags);
    }
  }

  private async mutate<Result>(
    transition: (
      state: CredentialAuthorityEnvelope,
      now: number,
    ) => TransitionResult<Result>,
  ): Promise<Result> {
    this.assertReady();
    let publicationStarted = false;
    let liveAuthorizationBarrier: RelayV2LiveAuthorizationCommitBarrier | null = null;
    let liveAuthorizationBarrierSettled = false;
    const flags = {
      storePublicationUncertain: false,
      definiteStateConflict: false,
      definiteStateInvalid: false,
    };
    try {
      return await this.store.runExclusive(async (transaction) => {
        // A prior queued operation may have withdrawn admission while this
        // callback waited for N0's exclusive lease.
        this.assertReady();
        try {
          const read = await transaction.read();
          if (read.outcome !== "present" || this.currentCheckpoint === null) {
            throw authorityError("STATE_INVALID");
          }
          const currentState = parseEnvelope(read.bytes, this.anchorId);
          const current = checkpointForBytes(currentState, read.bytes);
          if (!sameCheckpoint(current, this.currentCheckpoint)) {
            flags.definiteStateConflict = true;
            throw authorityError("STATE_CONFLICT");
          }
          const working = cloneEnvelope(currentState);
          const now = this.observedNow(working.lastObservedAtMs);
          const pruned = pruneExpiredAuthorityState(working, now);
          const outcome = transition(working, now);
          if (!pruned && !outcome.changed) {
            if (outcome.disposition === "reject") throw new DomainRejection(outcome.error);
            return outcome.value;
          }
          working.parentCommitId = currentState.commitId;
          working.commitSequence = nextUint64(currentState.commitSequence);
          working.commitId = this.generatedId();
          if (working.commitId === currentState.commitId) {
            throw authorityError("STATE_CAPACITY_EXHAUSTED");
          }
          working.lastObservedAtMs = now;
          const nextBytes = encodeEnvelope(working);
          const next = checkpointForBytes(working, nextBytes);
          if (
            outcome.disposition === "return"
            && outcome.liveAuthorizationInvalidation !== undefined
          ) {
            if (!this.liveAuthorizationFence) {
              throw new DomainRejection(
                authorityError("LIVE_AUTHORIZATION_FENCE_UNAVAILABLE"),
              );
            }
            let candidateBarrier: unknown;
            try {
              candidateBarrier = this.liveAuthorizationFence.begin(
                outcome.liveAuthorizationInvalidation,
              );
            } catch {
              throw new DomainRejection(
                authorityError("LIVE_AUTHORIZATION_FENCE_UNAVAILABLE"),
              );
            }
            const installedBarrier = cloneLiveAuthorizationCommitBarrier(candidateBarrier);
            if (!installedBarrier) {
              // begin may already have installed unknown state. Treat a
              // malformed barrier as fatal so withdrawal closes admission
              // before its failClosed notification can re-enter authority.
              throw authorityError("LIVE_AUTHORIZATION_FENCE_UNAVAILABLE");
            }
            liveAuthorizationBarrier = installedBarrier;
          }
          publicationStarted = true;
          await this.continuity.advance({
            current,
            next,
            publishState: async (_expected, _next, signal) => (
              this.publishWithinTransaction(transaction, read.revision, nextBytes, signal, flags)
            ),
          });
          this.currentCheckpoint = next;
          if (liveAuthorizationBarrier) {
            liveAuthorizationBarrier.committed({
              authorizationRevision: working.commitSequence,
              authorizationFence: working.commitId,
            });
            liveAuthorizationBarrierSettled = true;
          }
          if (outcome.disposition === "reject") throw new DomainRejection(outcome.error);
          return outcome.value;
        } catch (error) {
          if (liveAuthorizationBarrier && !liveAuthorizationBarrierSettled) {
            try {
              if (publicationStarted) liveAuthorizationBarrier.failClosed();
              else liveAuthorizationBarrier.cancelled();
            } catch {
              // The authority still withdraws below; an injected fence owner
              // can never turn publication uncertainty into reopened admission.
            }
            liveAuthorizationBarrierSettled = true;
          }
          if (error instanceof DomainRejection) throw error;
          if (
            !publicationStarted
            && error instanceof RelayV2BrokerCredentialAuthorityError
            && error.code === "STATE_CAPACITY_EXHAUSTED"
          ) throw error;
          const mapped = mapFatalAuthorityError(error, flags);
          // Withdraw synchronously before N0 releases this callback. close()
          // remains outside the callback so its drain barrier cannot deadlock.
          this.withdrawAdmission(mapped.code);
          throw mapped;
        }
      });
    } catch (error) {
      if (error instanceof DomainRejection) throw error.authorityError;
      if (
        !publicationStarted
        && error instanceof RelayV2BrokerCredentialAuthorityError
        && error.code === "STATE_CAPACITY_EXHAUSTED"
      ) throw error;
      const mapped = mapFatalAuthorityError(error, flags);
      return await this.withdrawAndClose(mapped);
    }
  }

  private async publishWithinTransaction<TransactionScope>(
    transaction: RelayV2BrokerCredentialStateTransaction<TransactionScope>,
    revision: RelayV2BrokerCredentialStateRevision<TransactionScope>,
    nextBytes: Uint8Array,
    signal: AbortSignal,
    flags: {
      storePublicationUncertain: boolean;
      definiteStateConflict: boolean;
      definiteStateInvalid: boolean;
    },
  ): Promise<RelayV2ContinuityLocalCasResult> {
    if (signal.aborted) {
      flags.storePublicationUncertain = true;
      return { outcome: "uncertain" };
    }
    let result;
    try {
      result = await transaction.compareAndPublish(revision, nextBytes);
    } catch (error) {
      flags.storePublicationUncertain = true;
      throw error;
    }
    if (result.outcome === "uncertain") {
      flags.storePublicationUncertain = true;
      return { outcome: "uncertain" };
    }
    if (result.current.outcome !== "present") {
      flags.definiteStateConflict = true;
      return { outcome: "uncertain" };
    }
    let state: CredentialAuthorityEnvelope;
    try {
      state = parseEnvelope(result.current.bytes, this.anchorId);
    } catch {
      if (result.outcome === "conflict") flags.definiteStateInvalid = true;
      else flags.storePublicationUncertain = true;
      return { outcome: "uncertain" };
    }
    const current = checkpointForBytes(state, result.current.bytes);
    if (result.outcome === "swapped" || result.outcome === "already_same") {
      if (!Buffer.from(result.current.bytes).equals(Buffer.from(nextBytes))) {
        flags.storePublicationUncertain = true;
        return { outcome: "uncertain" };
      }
      return { outcome: result.outcome, current };
    }
    flags.definiteStateConflict = true;
    return { outcome: "conflict", current };
  }

  private async readState<Result>(
    reader: (state: CredentialAuthorityEnvelope, now: number) => Result,
  ): Promise<Result> {
    this.assertReady();
    try {
      return await this.store.runExclusive(async (transaction) => {
        // Recheck after acquiring N0's lease; a fatal predecessor may have
        // withdrawn this authority while the callback was queued.
        this.assertReady();
        try {
          const read = await transaction.read();
          if (read.outcome !== "present" || this.currentCheckpoint === null) {
            throw authorityError("STATE_INVALID");
          }
          const state = parseEnvelope(read.bytes, this.anchorId);
          const checkpoint = checkpointForBytes(state, read.bytes);
          if (!sameCheckpoint(checkpoint, this.currentCheckpoint)) {
            throw authorityError("STATE_CONFLICT");
          }
          return reader(state, this.observedNow(state.lastObservedAtMs));
        } catch (error) {
          if (isReadDomainError(error)) throw error;
          const mapped = mapFatalAuthorityError(error, {
            storePublicationUncertain: false,
            definiteStateConflict: false,
            definiteStateInvalid: error instanceof RelayV2BrokerCredentialAuthorityError
              && error.code === "STATE_INVALID",
          });
          this.withdrawAdmission(mapped.code);
          throw mapped;
        }
      });
    } catch (error) {
      if (isReadDomainError(error)) throw error;
      const mapped = mapFatalAuthorityError(error, {
        storePublicationUncertain: false,
        definiteStateConflict: false,
        definiteStateInvalid: error instanceof RelayV2BrokerCredentialAuthorityError
          && error.code === "STATE_INVALID",
      });
      return await this.withdrawAndClose(mapped);
    }
  }

  async adminRotateIssuerKey(input: {
    kid: string;
    secretBase64url?: string;
  }): Promise<{ kid: string }> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "kid",
      ...(Object.hasOwn(input, "secretBase64url") ? ["secretBase64url"] : []),
    ])) throw authorityError("INVALID_ARGUMENT");
    const kid = ensureIdentifier(input.kid);
    return this.mutate((state, now) => {
      const issuerKeyIdentities = 1
        + state.issuer.verifyOnlyKeys.length
        + state.issuer.retiredKids.length;
      if (issuerKeyIdentities >= MAX_ISSUER_KEY_IDENTITIES) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      try {
        state.issuer = rotateRelayV2IssuerKeyring(state.issuer, {
          kid,
          ...(input.secretBase64url === undefined
            ? {}
            : { secretBase64url: input.secretBase64url }),
          nowSeconds: Math.floor(now / 1_000),
        });
      } catch {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      return returnTransition({ kid }, true);
    });
  }

  async adminRemoveIssuerKey(input: {
    kid: string;
    emergency?: boolean;
  }): Promise<{ kid: string }> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "kid",
      ...(Object.hasOwn(input, "emergency") ? ["emergency"] : []),
    ])) throw authorityError("INVALID_ARGUMENT");
    const kid = ensureIdentifier(input.kid);
    if (input.emergency !== undefined && typeof input.emergency !== "boolean") {
      throw authorityError("INVALID_ARGUMENT");
    }
    return this.mutate((state, now) => {
      try {
        state.issuer = removeRelayV2VerifyOnlyKey(state.issuer, kid, {
          nowSeconds: Math.floor(now / 1_000),
          ...(input.emergency === undefined ? {} : { emergency: input.emergency }),
        });
      } catch {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      return returnTransition({ kid }, true, {
        reason: "kid_removed",
        kid,
      });
    });
  }

  async adminRotateReplayKey(input: {
    rotationId: string;
  }): Promise<Readonly<{ rotationId: string; replayKeyId: string }>> {
    if (!isRecord(input) || !hasExactKeys(input, ["rotationId"])) {
      throw authorityError("INVALID_ARGUMENT");
    }
    const rotationId = ensureIdentifier(input.rotationId);
    return this.mutate((state) => {
      const prior = state.replayKeyring.rotations.find((item) => (
        item.rotationId === rotationId
      ));
      if (prior) {
        return returnTransition(Object.freeze({
          rotationId: prior.rotationId,
          replayKeyId: prior.replayKeyId,
        }), false);
      }
      if (state.replayKeyring.rotations.length >= MAX_REPLAY_KEY_ROTATIONS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const activeKey = state.replayKeyring.activeKey;
      const activeKeyHasReplay = state.replays.some((record) => (
        record.replayKeyId === activeKey.replayKeyId
      ));
      if (
        activeKeyHasReplay
        && state.replayKeyring.decryptOnlyKeys.length >= MAX_REPLAY_DECRYPT_ONLY_KEYS
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      const replayKeyId = replayKeyIdForRotation(state.anchorId, rotationId);
      if (
        replayKeyId === state.replayKeyring.originKeyId
        || state.replayKeyring.rotations.some((item) => item.replayKeyId === replayKeyId)
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      const keyBase64url = Buffer.from(this.randomExact(32)).toString("base64url");
      if (
        keyBase64url === activeKey.keyBase64url
        || state.replayKeyring.decryptOnlyKeys.some((item) => (
          item.keyBase64url === keyBase64url
        ))
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      if (activeKeyHasReplay) {
        state.replayKeyring.decryptOnlyKeys.push(activeKey);
        state.replayKeyring.decryptOnlyKeys.sort((left, right) => (
          compareUtf8(left.replayKeyId, right.replayKeyId)
        ));
      }
      state.replayKeyring.activeKey = {
        replayKeyId,
        keyBase64url,
        legacyAad: false,
      };
      state.replayKeyring.rotations.push({
        rotationId,
        replayKeyId,
        commitSequence: nextUint64(state.commitSequence),
      });
      return returnTransition(Object.freeze({ rotationId, replayKeyId }), true);
    });
  }

  async adminCreateHostBootstrap(input: {
    expiresInMs?: number;
  } = {}): Promise<RelayV2BrokerCredentialHostBootstrapCreated> {
    if (!isRecord(input) || !hasExactKeys(input, [
      ...(Object.hasOwn(input, "expiresInMs") ? ["expiresInMs"] : []),
    ])) throw authorityError("INVALID_ARGUMENT");
    const expiresInMs = input.expiresInMs
      ?? RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS;
    if (
      !Number.isSafeInteger(expiresInMs)
      || expiresInMs <= 0
      || expiresInMs > RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_TTL_MS
    ) throw authorityError("INVALID_ARGUMENT");
    return this.mutate((state, now) => {
      if (state.hostBootstraps.length >= MAX_HOST_BOOTSTRAPS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const expiresAtMs = now + expiresInMs;
      if (
        !Number.isSafeInteger(expiresAtMs)
        || expiresAtMs > Number.MAX_SAFE_INTEGER
          - RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      const bootstrapToken = generatedHostBootstrapToken(
        this.randomExact(16),
        this.randomExact(32),
      );
      const parsed = hostBootstrapCredentialInput(bootstrapToken);
      if (
        state.hostBootstraps.some((record) => (
          record.selector === parsed.selector || record.tokenHash === parsed.tokenHash
        ))
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      state.hostBootstraps.push({
        selector: parsed.selector,
        tokenHash: parsed.tokenHash,
        createdAtMs: now,
        expiresAtMs,
        failedAttempts: 0,
        terminalAtMs: null,
        terminalReason: null,
      });
      state.hostBootstraps.sort((left, right) => compareUtf8(left.selector, right.selector));
      return returnTransition(Object.freeze({ bootstrapToken, expiresAtMs }), true);
    });
  }

  async authorizeAccessToken(
    token: string,
    expectedRole: RelayV2AccessRole,
  ): Promise<RelayV2BrokerConnectionAuthorization> {
    if (expectedRole !== "client" && expectedRole !== "host") {
      throw authorityError("INVALID_ARGUMENT");
    }
    const accessToken = accessTokenInput(token);
    return this.readState((state, now) => bindConnectionAuthorization(
      state,
      verifyAuthorizedAccessToken(state, accessToken, expectedRole, now),
    ));
  }

  private async createEnrollment(input: {
    requestId: string;
    connectorId: string;
    expiresInMs: number;
    deviceLabel: string | null;
    currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>;
  }): Promise<RelayV2BrokerCredentialEnrollmentCreated> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "requestId",
      "connectorId",
      "expiresInMs",
      "deviceLabel",
      "currentAuthContext",
    ])) throw authorityError("INVALID_ARGUMENT");
    const requestId = ensureIdentifier(input.requestId);
    const connectorId = ensureIdentifier(input.connectorId);
    if (
      !Number.isSafeInteger(input.expiresInMs)
      || input.expiresInMs <= 0
      || input.expiresInMs > 300_000
      || (input.deviceLabel !== null
        && (typeof input.deviceLabel !== "string"
          || Buffer.byteLength(input.deviceLabel, "utf8") > 128))
    ) throw authorityError("INVALID_ARGUMENT");
    return this.mutate((state, now) => {
      let hostId: string;
      try {
        hostId = revalidateCurrentAuthContext(
          state,
          input.currentAuthContext,
          now,
          "host",
        ).hostId;
      } catch (error) {
        if (error instanceof RelayV2BrokerCredentialAuthorityError) {
          return rejectTransition(error.code, false);
        }
        throw error;
      }
      const fingerprint = fixedFieldFingerprint({
        hostId,
        connectorId,
        expiresInMs: input.expiresInMs,
        deviceLabel: input.deviceLabel,
      }, ["hostId", "connectorId", "expiresInMs", "deviceLabel"]);
      const replay = replayFor(state, "enrollment.create", connectorId, requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        }
        const response = enrollmentCreatedFromFrame(
          openReplayResponse(state, replay),
          true,
          { requestId, connectorId },
        );
        return returnTransition(response, false);
      }
      if (state.enrollments.length >= MAX_ENROLLMENTS || state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const enrollmentId = this.generatedId();
      const enrollmentCode = generatedSecret("twenroll2", this.randomExact(32));
      const expiresAtMs = now + input.expiresInMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      state.enrollments.push({
        enrollmentId,
        hostId,
        codeHash: sha256Hex(enrollmentCode),
        createdAtMs: now,
        expiresAtMs,
        failedAttempts: 0,
        consumedAtMs: null,
      });
      state.enrollments.sort((left, right) => compareUtf8(left.enrollmentId, right.enrollmentId));
      const response = enrollmentCreatedFrame({
        requestId,
        connectorId,
        enrollmentId,
        enrollmentCode,
        hostId,
        issuerUrl: state.issuerUrl,
        relayUrl: state.relayUrl,
        expiresAtMs,
      });
      addReplay(state, {
        operation: "enrollment.create",
        subjectId: connectorId,
        attemptId: requestId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition(enrollmentCreatedFromFrame(
        response,
        false,
        { requestId, connectorId },
      ), true);
    });
  }

  private async reauthenticateHost(input: {
    requestId: string;
    connectorId: string;
    accessToken: string;
    currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>;
  }): Promise<RelayV2AuthControlDecision> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "requestId", "connectorId", "accessToken", "currentAuthContext",
    ])) throw authorityError("INVALID_ARGUMENT");
    const requestId = ensureIdentifier(input.requestId);
    const connectorId = ensureIdentifier(input.connectorId);
    const accessToken = accessTokenInput(input.accessToken);
    const accessTokenHash = sha256Hex(accessToken);
    return this.mutate<RelayV2AuthControlDecision>((state, now) => {
      try {
        revalidateCurrentAuthContext(state, input.currentAuthContext, now, "host");
      } catch (error) {
        if (error instanceof RelayV2BrokerCredentialAuthorityError) {
          return rejectTransition(error.code, false);
        }
        throw error;
      }
      let nextAuthContext: RelayV2BrokerConnectionAuthorization;
      try {
        nextAuthContext = bindConnectionAuthorization(
          state,
          verifyAuthorizedAccessToken(state, accessToken, "host", now),
        );
      } catch (error) {
        if (error instanceof RelayV2BrokerCredentialAuthorityError) {
          return rejectTransition(error.code, false);
        }
        throw error;
      }
      if (
        nextAuthContext.hostId !== input.currentAuthContext.hostId
        || nextAuthContext.principalId !== input.currentAuthContext.principalId
        || nextAuthContext.grantId !== input.currentAuthContext.grantId
        || nextAuthContext.clientInstanceId !== null
      ) return rejectTransition("PERMISSION_DENIED", false);
      const fingerprint = fixedFieldFingerprint({
        connectorId,
        jti: nextAuthContext.jti,
        accessTokenHash,
      }, ["connectorId", "jti", "accessTokenHash"]);
      const replay = replayFor(state, "host.reauthenticate", connectorId, requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        }
        const response = hostReauthenticatedFromFrame(
          openReplayResponse(state, replay),
          true,
          { requestId, connectorId },
        );
        const payload = response.payload as RelayV2JsonObject;
        if (
          payload.grantId !== nextAuthContext.grantId
          || payload.jti !== nextAuthContext.jti
          || payload.expiresAtMs !== nextAuthContext.expiresAtMs
        ) throw authorityError("STATE_INVALID");
        return returnTransition({
          outcome: "success",
          response,
          replayed: true,
          nextAuthContext,
        }, false);
      }
      if (nextAuthContext.jti === input.currentAuthContext.jti) {
        return rejectTransition("AUTH_INVALID", false);
      }
      if (state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const response = hostReauthenticatedFrame({
        requestId,
        connectorId,
        grantId: nextAuthContext.grantId,
        jti: nextAuthContext.jti,
        expiresAtMs: nextAuthContext.expiresAtMs,
      });
      addReplay(state, {
        operation: "host.reauthenticate",
        subjectId: connectorId,
        attemptId: requestId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition({
        outcome: "success",
        response,
        replayed: false,
        nextAuthContext,
      }, true);
    });
  }

  private async revokeGrant(input: {
    requestId: string;
    connectorId: string;
    grantId: string;
    reason: "user_revoked";
    currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>;
  }): Promise<RelayV2AuthControlDecision> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "requestId", "connectorId", "grantId", "reason", "currentAuthContext",
    ])) throw authorityError("INVALID_ARGUMENT");
    const requestId = ensureIdentifier(input.requestId);
    const connectorId = ensureIdentifier(input.connectorId);
    const grantId = ensureIdentifier(input.grantId);
    if (input.reason !== "user_revoked") throw authorityError("INVALID_ARGUMENT");
    return this.mutate<RelayV2AuthControlDecision>((state, now) => {
      let hostGrant: GrantRecord;
      try {
        hostGrant = revalidateCurrentAuthContext(
          state,
          input.currentAuthContext,
          now,
          "host",
        );
      } catch (error) {
        if (error instanceof RelayV2BrokerCredentialAuthorityError) {
          return rejectTransition(error.code, false);
        }
        throw error;
      }
      const fingerprint = fixedFieldFingerprint({
        hostId: hostGrant.hostId,
        connectorId,
        grantId,
        reason: input.reason,
      }, ["hostId", "connectorId", "grantId", "reason"]);
      const replay = replayFor(state, "grant.revoke", connectorId, requestId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        }
        return returnTransition({
          outcome: "success",
          response: grantRevokedFromFrame(
            openReplayResponse(state, replay),
            { requestId, connectorId },
          ),
          replayed: true,
        }, false);
      }
      const target = state.grants.find((candidate) => candidate.grantId === grantId);
      if (!target) return rejectTransition("GRANT_NOT_FOUND", false);
      if (target.role !== "client" || target.hostId !== hostGrant.hostId) {
        return rejectTransition("PERMISSION_DENIED", false);
      }
      if (state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const alreadyRevoked = target.revokedAtMs !== null;
      const revokedAtMs = target.revokedAtMs ?? now;
      const response = grantRevokedFrame({
        requestId,
        connectorId,
        grantId,
        revokedAtMs,
        alreadyRevoked,
      });
      if (!alreadyRevoked) target.revokedAtMs = revokedAtMs;
      addReplay(state, {
        operation: "grant.revoke",
        subjectId: connectorId,
        attemptId: requestId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition({
        outcome: "success",
        response,
        replayed: false,
      }, true, alreadyRevoked ? undefined : {
        reason: "grant_revoked",
        role: "client",
        hostId: target.hostId,
        grantId: target.grantId,
      });
    });
  }

  async admitHttpSource(input: {
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint;
    sourceKey: string;
  }): Promise<RelayV2BrokerCredentialHttpSourceAdmission> {
    if (
      !isRecord(input)
      || !hasExactKeys(input, ["endpoint", "sourceKey"])
      || ![
        "enrollment_redeem",
        "client_refresh",
        "host_bootstrap",
        "host_refresh",
        "self_revoke",
      ].includes(input.endpoint)
    ) throw authorityError("INVALID_ARGUMENT");
    this.assertReady();
    const sourceHash = sourceIdentityHash(input.sourceKey);
    let reservationNow: number;
    try {
      reservationNow = this.observedNow(0);
    } catch (error) {
      const mapped = mapFatalAuthorityError(error, {
        storePublicationUncertain: false,
        definiteStateConflict: false,
        definiteStateInvalid: true,
      });
      return await this.withdrawAndClose(mapped);
    }
    for (const [receipt, record] of this.sourceAdmissions) {
      if (!record.pending && record.expiresAtMs <= reservationNow) {
        this.sourceAdmissions.delete(receipt);
      }
    }
    if (this.sourceAdmissions.size >= MAX_SOURCE_ADMISSIONS) {
      throw authorityError("BUSY");
    }
    const reservationExpiresAtMs = reservationNow
      + RELAY_V2_BROKER_CREDENTIAL_SOURCE_ADMISSION_TTL_MS;
    if (!Number.isSafeInteger(reservationExpiresAtMs)) {
      throw authorityError("STATE_CAPACITY_EXHAUSTED");
    }
    // Functions have no JSON/structured-clone representation. The private map
    // is the only runtime proof, so a lookalike or copied value is rejected.
    const receipt = Object.freeze(() => undefined) as unknown as
      RelayV2BrokerCredentialHttpSourceAdmission;
    this.sourceAdmissions.set(receipt as object, {
      endpoint: input.endpoint,
      sourceHash,
      expiresAtMs: reservationExpiresAtMs,
      pending: true,
    });
    try {
      const admittedAtMs = await this.mutate<number>((state, now) => {
        const rateLimitSubjectHash = input.endpoint === "enrollment_redeem"
          || input.endpoint === "host_bootstrap"
          ? sourceHash
          : sha256Hex(`${input.endpoint}\u0000${sourceHash}`);
        if (!consumeSourceRateLimit(
          state,
          input.endpoint,
          rateLimitSubjectHash,
          now,
        )) {
          return rejectTransition("RATE_LIMITED", false);
        }
        return returnTransition(now, true);
      });
      this.assertReady();
      const record = this.sourceAdmissions.get(receipt as object);
      if (!record) throw authorityError("AUTHORITY_NOT_READY");
      const expiresAtMs = admittedAtMs + RELAY_V2_BROKER_CREDENTIAL_SOURCE_ADMISSION_TTL_MS;
      if (!Number.isSafeInteger(expiresAtMs)) {
        this.sourceAdmissions.delete(receipt as object);
        throw authorityError("STATE_CAPACITY_EXHAUSTED");
      }
      record.expiresAtMs = expiresAtMs;
      record.pending = false;
      return receipt;
    } catch (error) {
      this.sourceAdmissions.delete(receipt as object);
      throw error;
    }
  }

  private takeSourceAdmission(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint,
    sourceHash: string,
  ): SourceAdmissionRecord {
    if ((typeof admission !== "object" && typeof admission !== "function") || admission === null) {
      throw authorityError("INVALID_ARGUMENT");
    }
    const record = this.sourceAdmissions.get(admission as object);
    if (
      !record
      || record.pending
      || record.endpoint !== endpoint
      || record.sourceHash !== sourceHash
    ) throw authorityError("INVALID_ARGUMENT");
    this.sourceAdmissions.delete(admission as object);
    return record;
  }

  private takeSourceAdmissionForTransition(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint,
    sourceHash: string,
  ): SourceAdmissionRecord {
    try {
      return this.takeSourceAdmission(admission, endpoint, sourceHash);
    } catch (error) {
      // Withdrawal clears every outstanding receipt synchronously. Attempt
      // exact ownership settlement first, then preserve the readiness failure
      // instead of misclassifying that race as a malformed request.
      this.assertReady();
      throw error;
    }
  }

  /**
   * Releases an admitted HTTP source receipt when the transport boundary
   * cannot hand a decoded request to the credential transition. The durable
   * rate attempt remains consumed. A copied, mismatched, or already released
   * receipt is never accepted. Expiry is checked against trusted transaction
   * time only by a credential transition; release merely settles ownership.
   */
  releaseHttpSourceAdmission(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint,
    sourceKey: string,
  ): void {
    this.takeSourceAdmission(admission, endpoint, sourceIdentityHash(sourceKey));
  }

  async refreshClientGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      refreshAttemptId: string;
      grantId: string;
      clientInstanceId: string;
      refreshToken: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential> {
    const sourceAdmission = this.takeSourceAdmissionForTransition(
      admission,
      "client_refresh",
      sourceIdentityHash(sourceKey),
    );
    return this.refreshGrantWithSourceAdmission(sourceAdmission, input);
  }

  async refreshHostGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      refreshAttemptId: string;
      grantId: string;
      hostInstanceId: string;
      refreshToken: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential> {
    const sourceAdmission = this.takeSourceAdmissionForTransition(
      admission,
      "host_refresh",
      sourceIdentityHash(sourceKey),
    );
    return this.refreshGrantWithSourceAdmission(sourceAdmission, input);
  }

  async selfRevokeGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>,
    input: { reason: "user_revoked" },
  ): Promise<Readonly<RelayV2BrokerCredentialSelfRevokeResult>> {
    const sourceAdmission = this.takeSourceAdmissionForTransition(
      admission,
      "self_revoke",
      sourceIdentityHash(sourceKey),
    );
    if (!isRecord(input) || !hasExactKeys(input, ["reason"])) {
      throw authorityError("INVALID_ARGUMENT");
    }
    if (input.reason !== "user_revoked") throw authorityError("INVALID_ARGUMENT");
    return this.mutate((state, now) => {
      if (sourceAdmission.expiresAtMs <= now) {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      let grant: GrantRecord;
      try {
        // A second request authenticated before the first revoke commit may
        // finish afterwards. Its trusted context can observe the same durable
        // revocation fact, but a post-commit token can no longer authenticate.
        grant = revalidateCurrentAuthContext(
          state,
          currentAuthContext,
          now,
          "client",
          { allowRevoked: true },
        );
      } catch (error) {
        if (error instanceof RelayV2BrokerCredentialAuthorityError) {
          return rejectTransition(error.code, false);
        }
        throw error;
      }
      const alreadyRevoked = grant.revokedAtMs !== null;
      const revokedAtMs = grant.revokedAtMs ?? now;
      if (!alreadyRevoked) grant.revokedAtMs = revokedAtMs;
      return returnTransition(Object.freeze({
        grantId: grant.grantId,
        revokedAtMs,
        alreadyRevoked,
      }), !alreadyRevoked, alreadyRevoked ? undefined : {
        reason: "grant_revoked",
        role: "client",
        hostId: grant.hostId,
        grantId: grant.grantId,
      });
    });
  }

  async bootstrapHost(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      bootstrapAttemptId: string;
      bootstrapToken: string;
      hostId: string;
      hostEpoch: string;
      hostInstanceId: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential> {
    const sourceAdmission = this.takeSourceAdmissionForTransition(
      admission,
      "host_bootstrap",
      sourceIdentityHash(sourceKey),
    );
    if (!isRecord(input) || !hasExactKeys(input, [
      "bootstrapAttemptId",
      "bootstrapToken",
      "hostId",
      "hostEpoch",
      "hostInstanceId",
    ])) throw authorityError("INVALID_ARGUMENT");
    const bootstrapAttemptId = ensureIdentifier(input.bootstrapAttemptId);
    const hostId = ensureIdentifier(input.hostId);
    const hostEpoch = ensureIdentifier(input.hostEpoch);
    const hostInstanceId = ensureIdentifier(input.hostInstanceId);
    const bootstrapToken = hostBootstrapCredentialInput(input.bootstrapToken);
    const fingerprint = fixedFieldFingerprint({
      selector: bootstrapToken.selector,
      tokenHash: bootstrapToken.tokenHash,
      hostId,
      hostEpoch,
      hostInstanceId,
    }, ["selector", "tokenHash", "hostId", "hostEpoch", "hostInstanceId"]);
    return this.mutate((state, now) => {
      if (sourceAdmission.expiresAtMs <= now) {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      const replay = replayForAttempt(state, "host.bootstrap", bootstrapAttemptId);
      if (replay) {
        if (
          replay.subjectId !== bootstrapToken.selector
          || replay.fingerprint !== fingerprint
        ) return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        return returnTransition(grantCredentialFromResponse(
          openReplayResponse(state, replay),
          true,
          { endpoint: "host_bootstrap", attemptId: bootstrapAttemptId },
        ), false);
      }
      const bootstrap = state.hostBootstraps.find((candidate) => (
        candidate.selector === bootstrapToken.selector
      ));
      if (
        !bootstrap
        || bootstrap.terminalAtMs !== null
        || bootstrap.expiresAtMs <= now
        || bootstrap.failedAttempts
          >= RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES
      ) return rejectTransition("AUTH_INVALID", false);
      if (!sameSha256Digest(bootstrap.tokenHash, bootstrapToken.tokenHash)) {
        bootstrap.failedAttempts += 1;
        if (
          bootstrap.failedAttempts
          === RELAY_V2_BROKER_CREDENTIAL_HOST_BOOTSTRAP_MAX_FAILURES
        ) {
          bootstrap.terminalAtMs = now;
          bootstrap.terminalReason = "failures_exhausted";
        }
        return rejectTransition("AUTH_INVALID", true);
      }
      if (state.grants.length >= MAX_GRANTS || state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const refreshExpiresAtMs = now + 30 * 24 * 60 * 60 * 1_000;
      if (
        !Number.isSafeInteger(refreshExpiresAtMs)
        || refreshExpiresAtMs > Number.MAX_SAFE_INTEGER
          - RELAY_V2_BROKER_CREDENTIAL_RESPONSE_REPLAY_RETENTION_MS
      ) return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      const ttlSeconds = accessTtlSeconds(refreshExpiresAtMs, now);
      if (ttlSeconds === null) return rejectTransition("AUTH_INVALID", false);
      const principalId = this.generatedId();
      const grantId = this.generatedId();
      const refreshToken = generatedSecret("twref2", this.randomExact(32));
      const grant: GrantRecord = {
        role: "host",
        hostId,
        principalId,
        grantId,
        clientInstanceId: null,
        refreshTokenHash: sha256Hex(refreshToken),
        credentialVersion: "1",
        refreshExpiresAtMs,
        maxAccessExpiresAtMs: 0,
        revokedAtMs: null,
      };
      let prepared;
      try {
        prepared = prepareRelayV2AccessTokenIssuance(state.issuer, {
          role: "host",
          hostId,
          principalId,
          grantId,
          nowSeconds: Math.floor(now / 1_000),
          ttlSeconds,
          jti: this.generatedId(),
        });
      } catch {
        throw authorityError("STATE_INVALID");
      }
      state.issuer = prepared.nextKeyring;
      grant.maxAccessExpiresAtMs = prepared.claims.exp * 1_000;
      state.grants.push(grant);
      state.grants.sort((left, right) => compareUtf8(left.grantId, right.grantId));
      bootstrap.terminalAtMs = now;
      bootstrap.terminalReason = "consumed";
      const response: RelayV2JsonObject = {
        bootstrapAttemptId,
        principalId,
        grantId,
        hostId,
        accessToken: prepared.token,
        accessExpiresAtMs: prepared.claims.exp * 1_000,
        refreshToken,
        refreshExpiresAtMs,
      };
      addReplay(state, {
        operation: "host.bootstrap",
        subjectId: bootstrapToken.selector,
        attemptId: bootstrapAttemptId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition(grantCredentialFromResponse(
        response,
        false,
        { endpoint: "host_bootstrap", attemptId: bootstrapAttemptId },
      ), true);
    });
  }

  async redeemEnrollment(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      exchangeAttemptId: string;
      enrollmentId: string;
      enrollmentCode: string;
      clientInstanceId: string;
      deviceLabel: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential> {
    const sourceAdmission = this.takeSourceAdmissionForTransition(
      admission,
      "enrollment_redeem",
      sourceIdentityHash(sourceKey),
    );
    if (!isRecord(input) || !hasExactKeys(input, [
      "exchangeAttemptId",
      "enrollmentId",
      "enrollmentCode",
      "clientInstanceId",
      "deviceLabel",
    ])) throw authorityError("INVALID_ARGUMENT");
    const exchangeAttemptId = ensureIdentifier(input.exchangeAttemptId);
    const enrollmentId = ensureIdentifier(input.enrollmentId);
    const clientInstanceId = ensureIdentifier(input.clientInstanceId);
    const enrollmentCode = credentialInput(input.enrollmentCode, "twenroll2");
    if (
      typeof input.deviceLabel !== "string"
      || Buffer.byteLength(input.deviceLabel, "utf8") > 128
    ) throw authorityError("INVALID_ARGUMENT");
    const codeHash = sha256Hex(enrollmentCode);
    const fingerprint = fixedFieldFingerprint({
      enrollmentId,
      codeHash,
      clientInstanceId,
      deviceLabel: input.deviceLabel,
    }, ["enrollmentId", "codeHash", "clientInstanceId", "deviceLabel"]);
    return this.mutate((state, now) => {
      if (sourceAdmission.expiresAtMs <= now) {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      const replay = replayFor(state, "enrollment.redeem", enrollmentId, exchangeAttemptId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        }
        return returnTransition(grantCredentialFromResponse(
          openReplayResponse(state, replay),
          true,
          { endpoint: "enrollment_redeem", attemptId: exchangeAttemptId },
        ), false);
      }
      const enrollment = state.enrollments.find((candidate) => (
        candidate.enrollmentId === enrollmentId
      ));
      if (
        !enrollment
        || enrollment.consumedAtMs !== null
        || enrollment.expiresAtMs <= now
        || enrollment.failedAttempts >= RELAY_V2_BROKER_CREDENTIAL_ENROLLMENT_MAX_FAILURES
      ) return rejectTransition("AUTH_INVALID", false);
      if (!sameSha256Digest(enrollment.codeHash, codeHash)) {
        enrollment.failedAttempts += 1;
        return rejectTransition("AUTH_INVALID", true);
      }
      if (state.grants.length >= MAX_GRANTS || state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const principalId = this.generatedId();
      const grantId = this.generatedId();
      const refreshToken = generatedSecret("twref2", this.randomExact(32));
      const refreshExpiresAtMs = now + 30 * 24 * 60 * 60 * 1_000;
      if (!Number.isSafeInteger(refreshExpiresAtMs)) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const ttlSeconds = accessTtlSeconds(refreshExpiresAtMs, now);
      if (ttlSeconds === null) return rejectTransition("AUTH_INVALID", false);
      const grant: GrantRecord = {
        role: "client",
        hostId: enrollment.hostId,
        principalId,
        grantId,
        clientInstanceId,
        refreshTokenHash: sha256Hex(refreshToken),
        credentialVersion: "1",
        refreshExpiresAtMs,
        maxAccessExpiresAtMs: 0,
        revokedAtMs: null,
      };
      let prepared;
      try {
        prepared = prepareRelayV2AccessTokenIssuance(state.issuer, {
          role: "client",
          hostId: grant.hostId,
          principalId,
          grantId,
          clientInstanceId,
          nowSeconds: Math.floor(now / 1_000),
          ttlSeconds,
          jti: this.generatedId(),
        });
      } catch {
        throw authorityError("STATE_INVALID");
      }
      state.issuer = prepared.nextKeyring;
      grant.maxAccessExpiresAtMs = prepared.claims.exp * 1_000;
      state.grants.push(grant);
      state.grants.sort((left, right) => compareUtf8(left.grantId, right.grantId));
      enrollment.consumedAtMs = now;
      const response: RelayV2JsonObject = {
        exchangeAttemptId,
        principalId,
        grantId,
        hostId: grant.hostId,
        relayUrl: state.relayUrl,
        accessToken: prepared.token,
        accessExpiresAtMs: prepared.claims.exp * 1_000,
        refreshToken,
        refreshExpiresAtMs,
      };
      addReplay(state, {
        operation: "enrollment.redeem",
        subjectId: enrollmentId,
        attemptId: exchangeAttemptId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition(grantCredentialFromResponse(
        response,
        false,
        { endpoint: "enrollment_redeem", attemptId: exchangeAttemptId },
      ), true);
    });
  }

  async refreshGrant(input: {
    refreshAttemptId: string;
    grantId: string;
    refreshToken: string;
    clientInstanceId?: string;
    hostInstanceId?: string;
  }): Promise<RelayV2BrokerCredentialGrantCredential> {
    return this.refreshGrantWithSourceAdmission(null, input);
  }

  private async refreshGrantWithSourceAdmission(
    sourceAdmission: SourceAdmissionRecord | null,
    input: {
      refreshAttemptId: string;
      grantId: string;
      refreshToken: string;
      clientInstanceId?: string;
      hostInstanceId?: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential> {
    if (!isRecord(input) || !hasExactKeys(input, [
      "refreshAttemptId",
      "grantId",
      "refreshToken",
      ...(Object.hasOwn(input, "clientInstanceId") ? ["clientInstanceId"] : []),
      ...(Object.hasOwn(input, "hostInstanceId") ? ["hostInstanceId"] : []),
    ])) throw authorityError("INVALID_ARGUMENT");
    const attemptId = ensureIdentifier(input.refreshAttemptId);
    const grantId = ensureIdentifier(input.grantId);
    const refreshToken = credentialInput(input.refreshToken, "twref2");
    const clientInstanceId = input.clientInstanceId === undefined
      ? undefined
      : ensureIdentifier(input.clientInstanceId);
    const hostInstanceId = input.hostInstanceId === undefined
      ? undefined
      : ensureIdentifier(input.hostInstanceId);
    if ((clientInstanceId === undefined) === (hostInstanceId === undefined)) {
      throw authorityError("INVALID_ARGUMENT");
    }
    const refreshBinding = clientInstanceId ?? hostInstanceId;
    if (refreshBinding === undefined) throw authorityError("INVALID_ARGUMENT");
    const responseEndpoint: "client_refresh" | "host_refresh" = clientInstanceId === undefined
      ? "host_refresh"
      : "client_refresh";
    const oldSecretHash = sha256Hex(refreshToken);
    const fingerprint = fixedFieldFingerprint({
      grantId,
      oldSecretHash,
      bindingKind: responseEndpoint,
      binding: refreshBinding,
    }, ["grantId", "oldSecretHash", "bindingKind", "binding"]);
    return this.mutate((state, now) => {
      if (sourceAdmission !== null && sourceAdmission.expiresAtMs <= now) {
        return rejectTransition("INVALID_ARGUMENT", false);
      }
      const replay = replayFor(state, "grant.refresh", grantId, attemptId);
      if (replay) {
        if (replay.fingerprint !== fingerprint) {
          return rejectTransition("IDEMPOTENCY_CONFLICT", false);
        }
        return returnTransition(grantCredentialFromResponse(
          openReplayResponse(state, replay),
          true,
          { endpoint: responseEndpoint, attemptId },
        ), false);
      }
      const grant = state.grants.find((candidate) => candidate.grantId === grantId);
      if (
        !grant
        || grant.revokedAtMs !== null
        || grant.refreshExpiresAtMs <= now
        || !sameSha256Digest(grant.refreshTokenHash, oldSecretHash)
        || (grant.role === "client"
          ? grant.clientInstanceId !== clientInstanceId || hostInstanceId !== undefined
          : clientInstanceId !== undefined || hostInstanceId === undefined)
      ) return rejectTransition("AUTH_INVALID", false);
      if (state.replays.length >= MAX_REPLAYS) {
        return rejectTransition("STATE_CAPACITY_EXHAUSTED", false);
      }
      const ttlSeconds = accessTtlSeconds(grant.refreshExpiresAtMs, now);
      if (ttlSeconds === null) return rejectTransition("AUTH_INVALID", false);
      const nextRefreshToken = generatedSecret("twref2", this.randomExact(32));
      let prepared;
      try {
        prepared = prepareRelayV2AccessTokenIssuance(state.issuer, {
          role: grant.role,
          hostId: grant.hostId,
          principalId: grant.principalId,
          grantId: grant.grantId,
          ...(grant.role === "client" ? { clientInstanceId: grant.clientInstanceId! } : {}),
          nowSeconds: Math.floor(now / 1_000),
          ttlSeconds,
          jti: this.generatedId(),
        });
      } catch {
        throw authorityError("STATE_INVALID");
      }
      state.issuer = prepared.nextKeyring;
      grant.refreshTokenHash = sha256Hex(nextRefreshToken);
      grant.credentialVersion = nextUint64(grant.credentialVersion);
      grant.maxAccessExpiresAtMs = Math.max(
        grant.maxAccessExpiresAtMs,
        prepared.claims.exp * 1_000,
      );
      const response: RelayV2JsonObject = {
        refreshAttemptId: attemptId,
        principalId: grant.principalId,
        grantId: grant.grantId,
        hostId: grant.hostId,
        ...(grant.role === "client" ? { relayUrl: state.relayUrl } : {}),
        accessToken: prepared.token,
        accessExpiresAtMs: prepared.claims.exp * 1_000,
        refreshToken: nextRefreshToken,
        refreshExpiresAtMs: grant.refreshExpiresAtMs,
      };
      addReplay(state, {
        operation: "grant.refresh",
        subjectId: grantId,
        attemptId,
        fingerprint,
      }, response, now, (length) => this.randomExact(length));
      return returnTransition(grantCredentialFromResponse(
        response,
        false,
        { endpoint: responseEndpoint, attemptId },
      ), true);
    });
  }

  async handle(request: RelayV2AuthControlRequest): Promise<RelayV2AuthControlDecision> {
    try {
      if (!isRecord(request)) throw authorityError("INVALID_ARGUMENT");
      if (request.type === "host.reauthenticate") {
        if (!hasExactKeys(request, [
          "type", "requestId", "connectorId", "accessToken", "currentAuthContext",
        ])) throw authorityError("INVALID_ARGUMENT");
        return await this.reauthenticateHost({
          requestId: request.requestId,
          connectorId: request.connectorId,
          accessToken: request.accessToken,
          currentAuthContext: request.currentAuthContext,
        });
      }
      if (request.type === "enrollment.create") {
        if (
          !hasExactKeys(request, [
            "type", "requestId", "connectorId", "payload", "currentAuthContext",
          ])
          || !isRecord(request.payload)
          || !hasExactKeys(request.payload, ["expiresInMs", "deviceLabel"])
        ) throw authorityError("INVALID_ARGUMENT");
        const created = await this.createEnrollment({
          requestId: request.requestId,
          connectorId: request.connectorId,
          expiresInMs: request.payload.expiresInMs as number,
          deviceLabel: request.payload.deviceLabel as string | null,
          currentAuthContext: request.currentAuthContext,
        });
        return {
          outcome: "success",
          response: enrollmentCreatedFrame({
            requestId: request.requestId,
            connectorId: request.connectorId,
            enrollmentId: created.enrollmentId,
            enrollmentCode: created.enrollmentCode,
            hostId: created.hostId,
            issuerUrl: created.issuerUrl,
            relayUrl: created.relayUrl,
            expiresAtMs: created.expiresAtMs,
            deduplicated: created.deduplicated,
          }),
          replayed: created.deduplicated,
        };
      }
      if (request.type === "grant.revoke") {
        if (
          !hasExactKeys(request, [
            "type", "requestId", "connectorId", "payload", "currentAuthContext",
          ])
          || !isRecord(request.payload)
          || !hasExactKeys(request.payload, ["grantId", "reason"])
          || !isRelayV2AuthIdentifier(request.payload.grantId)
          || request.payload.reason !== "user_revoked"
        ) throw authorityError("INVALID_ARGUMENT");
        return await this.revokeGrant({
          requestId: request.requestId,
          connectorId: request.connectorId,
          grantId: request.payload.grantId,
          reason: request.payload.reason,
          currentAuthContext: request.currentAuthContext,
        });
      }
      throw authorityError("INVALID_ARGUMENT");
    } catch (error) {
      if (error instanceof RelayV2BrokerCredentialAuthorityError) {
        return carrierDecisionForAuthorityError(error);
      }
      throw error;
    }
  }
}
