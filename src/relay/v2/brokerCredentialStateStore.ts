export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION = 1 as const;
export const RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION = 1 as const;
export const RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES = 64 * 1024 * 1024;

export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES = Object.freeze([
  "exclusive_transaction_v1",
  "opaque_transaction_revision_v1",
  "compare_and_publish_v1",
  "close_barrier_v1",
  "dual_slot_binary_v1",
] as const);

export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY =
  "payload_then_header_fsync_v1" as const;

export type RelayV2BrokerCredentialStateStoreUnsupportedReason =
  | "native_module_missing"
  | "platform_unsupported"
  | "runtime_unsupported"
  | "interface_version_unsupported"
  | "storage_format_unsupported";

export type RelayV2BrokerCredentialStateStoreErrorCode =
  | "NATIVE_INTERFACE_INVALID"
  | "STORE_BUSY"
  | "STORE_CLOSED"
  | "STORE_CORRUPT"
  | "STORE_FORMAT_UNSUPPORTED"
  | "STORE_IO"
  | "INVALID_ARGUMENT"
  | "INVALID_REVISION"
  | "STATE_TOO_LARGE"
  | "GENERATION_EXHAUSTED";

export interface RelayV2BrokerCredentialStateStoreFailure {
  code: RelayV2BrokerCredentialStateStoreErrorCode;
}

const ERROR_MESSAGES: Readonly<Record<RelayV2BrokerCredentialStateStoreErrorCode, string>> =
  Object.freeze({
    NATIVE_INTERFACE_INVALID: "Relay v2 broker credential native interface is invalid",
    STORE_BUSY: "Relay v2 broker credential state store is busy",
    STORE_CLOSED: "Relay v2 broker credential state store is closed",
    STORE_CORRUPT: "Relay v2 broker credential state store is corrupt",
    STORE_FORMAT_UNSUPPORTED: "Relay v2 broker credential state format is unsupported",
    STORE_IO: "Relay v2 broker credential state store I/O failed",
    INVALID_ARGUMENT: "Relay v2 broker credential state store argument is invalid",
    INVALID_REVISION: "Relay v2 broker credential state revision is invalid",
    STATE_TOO_LARGE: "Relay v2 broker credential state exceeds the frozen limit",
    GENERATION_EXHAUSTED: "Relay v2 broker credential storage generation is exhausted",
  });

export class RelayV2BrokerCredentialStateStoreError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: RelayV2BrokerCredentialStateStoreErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2BrokerCredentialStateStoreError";
    this.retryable = code === "STORE_BUSY";
  }
}

declare const RELAY_V2_BROKER_CREDENTIAL_REVISION_SCOPE: unique symbol;
declare const RELAY_V2_BROKER_CREDENTIAL_REVISION_VALUE: unique symbol;

/**
 * An adapter-issued comparison token. It has no serializable representation
 * and is valid only for the exact transaction that issued it.
 */
export interface RelayV2BrokerCredentialStateRevision<TransactionScope> {
  readonly [RELAY_V2_BROKER_CREDENTIAL_REVISION_SCOPE]: TransactionScope;
  readonly [RELAY_V2_BROKER_CREDENTIAL_REVISION_VALUE]: "opaque";
}

export type RelayV2BrokerCredentialStateRead<TransactionScope> =
  | {
      outcome: "missing";
      revision: RelayV2BrokerCredentialStateRevision<TransactionScope>;
    }
  | {
      outcome: "present";
      revision: RelayV2BrokerCredentialStateRevision<TransactionScope>;
      bytes: Uint8Array;
    };

export type RelayV2BrokerCredentialStatePublish<TransactionScope> =
  | {
      outcome: "swapped" | "already_same" | "conflict";
      revision: RelayV2BrokerCredentialStateRevision<TransactionScope>;
    }
  | { outcome: "uncertain" };

export interface RelayV2BrokerCredentialStateTransaction<TransactionScope> {
  read(): Promise<RelayV2BrokerCredentialStateRead<TransactionScope>>;

  /**
   * already_same is checked by exact bytes before expected-revision conflict.
   * uncertain exposes no revision and requires a later exclusive read before
   * the business authority can decide how to reconcile.
   */
  compareAndPublish(
    expected: RelayV2BrokerCredentialStateRevision<TransactionScope>,
    next: Uint8Array,
  ): Promise<RelayV2BrokerCredentialStatePublish<TransactionScope>>;
}

export interface RelayV2BrokerCredentialStateStore {
  /**
   * The callback is the whole exclusive transaction. Revisions become invalid
   * when it settles, and adapters must reject a token from any other callback.
   */
  runExclusive<Result>(
    operation: <TransactionScope>(
      transaction: RelayV2BrokerCredentialStateTransaction<TransactionScope>,
    ) => Result | PromiseLike<Result>,
  ): Promise<Result>;

  /**
   * Idempotent barrier: rejects new transactions, waits admitted callbacks,
   * and resolves only after native resources are closed.
   */
  close(): Promise<void>;
}

export interface RelayV2BrokerCredentialStateNativeBinding {
  relayV2BrokerCredentialStateCapability(): unknown;
  openRelayV2BrokerCredentialStateStore(): unknown | PromiseLike<unknown>;
}

export type RelayV2BrokerCredentialStateStoreCapability =
  | {
      status: "supported";
      nativeAbi: "napi";
      interfaceVersion: typeof RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION;
      storageFormatVersion: typeof RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION;
      maxStateBytes: typeof RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES;
      features: typeof RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES;
      durability: typeof RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY;
    }
  | {
      status: "unsupported";
      reason: RelayV2BrokerCredentialStateStoreUnsupportedReason;
    }
  | {
      status: "invalid";
      error: RelayV2BrokerCredentialStateStoreFailure;
    };

export type RelayV2BrokerCredentialStateStoreOpenResult =
  | {
      status: "opened";
      store: RelayV2BrokerCredentialStateStore;
    }
  | {
      status: "unsupported";
      reason: RelayV2BrokerCredentialStateStoreUnsupportedReason;
    }
  | {
      status: "invalid";
      error: RelayV2BrokerCredentialStateStoreFailure;
    };

const UNSUPPORTED_REASONS = new Set<RelayV2BrokerCredentialStateStoreUnsupportedReason>([
  "native_module_missing",
  "platform_unsupported",
  "runtime_unsupported",
  "interface_version_unsupported",
  "storage_format_unsupported",
]);

const ERROR_CODES = new Set<RelayV2BrokerCredentialStateStoreErrorCode>(
  Object.keys(ERROR_MESSAGES) as RelayV2BrokerCredentialStateStoreErrorCode[],
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function invalidFailure(): RelayV2BrokerCredentialStateStoreFailure {
  return Object.freeze({ code: "NATIVE_INTERFACE_INVALID" });
}

function parseFailure(value: unknown): RelayV2BrokerCredentialStateStoreFailure | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["code"])
    || typeof value.code !== "string"
    || !ERROR_CODES.has(value.code as RelayV2BrokerCredentialStateStoreErrorCode)
  ) return null;
  return Object.freeze({
    code: value.code as RelayV2BrokerCredentialStateStoreErrorCode,
  });
}

function parseUnsupported(
  value: Record<string, unknown>,
): RelayV2BrokerCredentialStateStoreUnsupportedReason | null {
  if (
    !hasExactKeys(value, ["status", "reason"])
    || value.status !== "unsupported"
    || typeof value.reason !== "string"
    || !UNSUPPORTED_REASONS.has(value.reason as RelayV2BrokerCredentialStateStoreUnsupportedReason)
  ) return null;
  return value.reason as RelayV2BrokerCredentialStateStoreUnsupportedReason;
}

function exactFeatures(value: unknown): value is typeof RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES {
  return Array.isArray(value)
    && value.length === RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES.length
    && value.every((feature, index) => (
      feature === RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES[index]
    ));
}

export function parseRelayV2BrokerCredentialStateStoreFailure(
  value: unknown,
): RelayV2BrokerCredentialStateStoreFailure {
  return parseFailure(value) ?? invalidFailure();
}

export function parseRelayV2BrokerCredentialStateStoreCapability(
  value: unknown,
): RelayV2BrokerCredentialStateStoreCapability {
  if (!isRecord(value) || typeof value.status !== "string") {
    return { status: "invalid", error: invalidFailure() };
  }
  if (value.status === "unsupported") {
    const reason = parseUnsupported(value);
    return reason === null
      ? { status: "invalid", error: invalidFailure() }
      : { status: "unsupported", reason };
  }
  if (value.status === "invalid") {
    if (!hasExactKeys(value, ["status", "error"])) {
      return { status: "invalid", error: invalidFailure() };
    }
    const error = parseFailure(value.error);
    return { status: "invalid", error: error ?? invalidFailure() };
  }
  if (
    value.status !== "supported"
    || !hasExactKeys(value, [
      "status",
      "nativeAbi",
      "interfaceVersion",
      "storageFormatVersion",
      "maxStateBytes",
      "features",
      "durability",
    ])
    || value.nativeAbi !== "napi"
    || value.interfaceVersion !== RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION
    || value.storageFormatVersion !== RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION
    || value.maxStateBytes !== RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES
    || !exactFeatures(value.features)
    || value.durability !== RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY
  ) return { status: "invalid", error: invalidFailure() };
  return {
    status: "supported",
    nativeAbi: "napi",
    interfaceVersion: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION,
    storageFormatVersion: RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION,
    maxStateBytes: RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
    features: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES,
    durability: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY,
  };
}

function isStore(value: unknown): value is RelayV2BrokerCredentialStateStore {
  return isRecord(value)
    && typeof value.runExclusive === "function"
    && typeof value.close === "function";
}

export function parseRelayV2BrokerCredentialStateStoreOpenResult(
  value: unknown,
): RelayV2BrokerCredentialStateStoreOpenResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    return { status: "invalid", error: invalidFailure() };
  }
  if (value.status === "unsupported") {
    const reason = parseUnsupported(value);
    return reason === null
      ? { status: "invalid", error: invalidFailure() }
      : { status: "unsupported", reason };
  }
  if (value.status === "invalid") {
    if (!hasExactKeys(value, ["status", "error"])) {
      return { status: "invalid", error: invalidFailure() };
    }
    const error = parseFailure(value.error);
    return { status: "invalid", error: error ?? invalidFailure() };
  }
  if (
    value.status !== "opened"
    || !hasExactKeys(value, ["status", "store"])
    || !isStore(value.store)
  ) return { status: "invalid", error: invalidFailure() };
  return { status: "opened", store: value.store };
}
