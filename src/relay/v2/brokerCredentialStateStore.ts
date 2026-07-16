import { isAbsolute } from "node:path";

export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION = 1 as const;
export const RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION = 1 as const;
export const RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES = 64 * 1024 * 1024;

export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES = Object.freeze([
  "process_wide_kernel_lock_v1",
  "exclusive_transaction_v1",
  "opaque_transaction_revision_v1",
  "compare_and_publish_v1",
  "close_barrier_v1",
  "dual_slot_binary_v1",
] as const);

export const RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY =
  "payload_then_header_durable_v1" as const;

export type RelayV2BrokerCredentialStateStoreUnsupportedReason =
  | "native_artifact_missing"
  | "target_unsupported"
  | "interface_version_unsupported";

export type RelayV2BrokerCredentialStateStoreErrorCode =
  | "NATIVE_INTERFACE_INVALID"
  | "STORE_BUSY"
  | "STORE_CLOSED"
  | "STORE_CORRUPT"
  | "STORE_FORMAT_UNSUPPORTED"
  | "STORE_IDENTITY_UNCERTAIN"
  | "STORE_IO"
  | "STORE_PERMISSION_INVALID"
  | "DURABILITY_UNSUPPORTED"
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
    STORE_IDENTITY_UNCERTAIN: "Relay v2 broker credential state identity is uncertain",
    STORE_IO: "Relay v2 broker credential state store I/O failed",
    STORE_PERMISSION_INVALID: "Relay v2 broker credential state permissions are invalid",
    DURABILITY_UNSUPPORTED: "Relay v2 broker credential state durability is unsupported",
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
      outcome: "swapped" | "already_same";
      current: Extract<
        RelayV2BrokerCredentialStateRead<TransactionScope>,
        { outcome: "present" }
      >;
    }
  | {
      outcome: "conflict";
      current: RelayV2BrokerCredentialStateRead<TransactionScope>;
    }
  | { outcome: "uncertain" };

export interface RelayV2BrokerCredentialStateTransaction<TransactionScope> {
  read(): Promise<RelayV2BrokerCredentialStateRead<TransactionScope>>;

  /**
   * already_same is checked by exact bytes before expected-revision conflict.
   * Definitive outcomes contain a fresh current snapshot and revision for
   * same-transaction reconciliation. uncertain exposes neither, immediately
   * terminal-closes this store instance, and requires close, explicit reopen,
   * a fresh native self-check, and authority continuity before readiness.
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

/**
 * The caller supplies the already-trusted absolute account-home root itself,
 * never a descendant path. Native open re-verifies root ownership, must not
 * consult HOME or derive input paths, and enforces the exact frozen limit.
 */
export interface RelayV2BrokerCredentialStateStoreOpenOptions {
  trustedHome: string;
  maxStateBytes: typeof RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES;
}

export interface RelayV2BrokerCredentialStateNativeBinding {
  relayV2BrokerCredentialStateCapability(): unknown;
  openRelayV2BrokerCredentialStateStore(
    options: RelayV2BrokerCredentialStateStoreOpenOptions,
  ): unknown | PromiseLike<unknown>;
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
      selfCheck: "passed";
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
  "native_artifact_missing",
  "target_unsupported",
  "interface_version_unsupported",
]);

const ERROR_CODES = new Set<RelayV2BrokerCredentialStateStoreErrorCode>(
  Object.keys(ERROR_MESSAGES) as RelayV2BrokerCredentialStateStoreErrorCode[],
);

/**
 * Once the raw publish method has been invoked, only these exact native errors
 * prove that publication never began. Every other failure terminal-fences the
 * wrapper because the native boundary can no longer prove that no bytes were
 * committed.
 */
const PUBLISH_PROVEN_NO_COMMIT_CODES = new Set<RelayV2BrokerCredentialStateStoreErrorCode>([
  "INVALID_ARGUMENT",
  "INVALID_REVISION",
  "STATE_TOO_LARGE",
  "GENERATION_EXHAUSTED",
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const sortedActual = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sortedActual.length === expected.length
    && sortedActual.every((key, index) => key === expected[index]);
}

function snapshotOwnDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return null;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotExactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const snapshot = snapshotOwnDataRecord(value);
  return snapshot !== null && hasExactKeys(snapshot, keys) ? snapshot : null;
}

function snapshotOwnDataField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function snapshotExactDataArray(value: unknown, length: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = [...Array.from({ length }, (_, index) => String(index)), "length"];
    if (!hasExactKeys(descriptors, keys)) return null;
    const lengthDescriptor = descriptors.length;
    if (!Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.value !== length) return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!Object.hasOwn(descriptor, "value")) return null;
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get as (...args: unknown[]) => unknown;
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get as (...args: unknown[]) => unknown;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get as (...args: unknown[]) => unknown;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;

type Uint8ArrayCopyResult =
  | { status: "copied"; bytes: Uint8Array }
  | { status: "invalid" }
  | { status: "too_large" };

function copyUint8Array(value: unknown, maxBytes: number): Uint8ArrayCopyResult {
  try {
    if (!ArrayBuffer.isView(value)) return { status: "invalid" };
    if (Reflect.apply(TYPED_ARRAY_TAG_GETTER, value, []) !== "Uint8Array") {
      return { status: "invalid" };
    }
    const length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []);
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (!Number.isSafeInteger(length) || length <= 0 || !(buffer instanceof ArrayBuffer)) {
      return { status: "invalid" };
    }
    if (length > maxBytes) return { status: "too_large" };
    const copied = new Uint8Array(length);
    Reflect.apply(UINT8_ARRAY_SET, copied, [value]);
    return { status: "copied", bytes: copied };
  } catch {
    return { status: "invalid" };
  }
}

function invalidFailure(): RelayV2BrokerCredentialStateStoreFailure {
  return Object.freeze({ code: "NATIVE_INTERFACE_INVALID" });
}

function failure(
  code: RelayV2BrokerCredentialStateStoreErrorCode,
): RelayV2BrokerCredentialStateStoreFailure {
  return Object.freeze({ code });
}

function parseFailure(value: unknown): RelayV2BrokerCredentialStateStoreFailure | null {
  const snapshot = snapshotExactDataRecord(value, ["code"]);
  if (
    snapshot === null
    || typeof snapshot.code !== "string"
    || !ERROR_CODES.has(snapshot.code as RelayV2BrokerCredentialStateStoreErrorCode)
  ) return null;
  return Object.freeze({
    code: snapshot.code as RelayV2BrokerCredentialStateStoreErrorCode,
  });
}

function parseUnsupported(
  value: Readonly<Record<string, unknown>>,
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
  const snapshot = snapshotExactDataArray(
    value,
    RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES.length,
  );
  return snapshot !== null
    && snapshot.every((feature, index) => (
      feature === RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES[index]
    ));
}

function snapshotOpenOptions(
  value: unknown,
): Readonly<RelayV2BrokerCredentialStateStoreOpenOptions> | null {
  const snapshot = snapshotExactDataRecord(value, ["trustedHome", "maxStateBytes"]);
  if (
    snapshot === null
    || typeof snapshot.trustedHome !== "string"
    || snapshot.trustedHome.length === 0
    || snapshot.trustedHome.includes("\0")
    || !isAbsolute(snapshot.trustedHome)
    || snapshot.maxStateBytes !== RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES
  ) return null;
  return Object.freeze({
    trustedHome: snapshot.trustedHome,
    maxStateBytes: RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  });
}

export function isRelayV2BrokerCredentialStateStoreOpenOptions(
  value: unknown,
): value is RelayV2BrokerCredentialStateStoreOpenOptions {
  return snapshotOpenOptions(value) !== null;
}

export function parseRelayV2BrokerCredentialStateStoreFailure(
  value: unknown,
): RelayV2BrokerCredentialStateStoreFailure {
  try {
    return parseFailure(value) ?? invalidFailure();
  } catch {
    return invalidFailure();
  }
}

function parseCapability(
  value: unknown,
): RelayV2BrokerCredentialStateStoreCapability {
  const snapshot = snapshotOwnDataRecord(value);
  if (snapshot === null || typeof snapshot.status !== "string") {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
  if (snapshot.status === "unsupported") {
    const reason = parseUnsupported(snapshot);
    return reason === null
      ? Object.freeze({ status: "invalid", error: invalidFailure() })
      : Object.freeze({ status: "unsupported", reason });
  }
  if (snapshot.status === "invalid") {
    if (!hasExactKeys(snapshot, ["status", "error"])) {
      return Object.freeze({ status: "invalid", error: invalidFailure() });
    }
    const error = parseFailure(snapshot.error);
    return Object.freeze({ status: "invalid", error: error ?? invalidFailure() });
  }
  if (
    snapshot.status !== "supported"
    || !hasExactKeys(snapshot, [
      "status",
      "nativeAbi",
      "interfaceVersion",
      "storageFormatVersion",
      "maxStateBytes",
      "features",
      "durability",
    ])
    || snapshot.nativeAbi !== "napi"
    || snapshot.interfaceVersion !== RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION
    || snapshot.storageFormatVersion !== RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION
    || snapshot.maxStateBytes !== RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES
    || !exactFeatures(snapshot.features)
    || snapshot.durability !== RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY
  ) return Object.freeze({ status: "invalid", error: invalidFailure() });
  return Object.freeze({
    status: "supported",
    nativeAbi: "napi",
    interfaceVersion: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_INTERFACE_VERSION,
    storageFormatVersion: RELAY_V2_BROKER_CREDENTIAL_STORAGE_FORMAT_VERSION,
    maxStateBytes: RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
    features: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_FEATURES,
    durability: RELAY_V2_BROKER_CREDENTIAL_STATE_STORE_DURABILITY,
  });
}

export function parseRelayV2BrokerCredentialStateStoreCapability(
  value: unknown,
): RelayV2BrokerCredentialStateStoreCapability {
  try {
    return parseCapability(value);
  } catch {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
}

function nativeOperationError(error: unknown): RelayV2BrokerCredentialStateStoreError {
  try {
    if (error instanceof RelayV2BrokerCredentialStateStoreError) {
      const code = snapshotOwnDataField(error, "code");
      if (
        typeof code === "string"
        && ERROR_CODES.has(code as RelayV2BrokerCredentialStateStoreErrorCode)
      ) {
        return new RelayV2BrokerCredentialStateStoreError(
          code as RelayV2BrokerCredentialStateStoreErrorCode,
        );
      }
    }
    const parsed = parseFailure(error);
    return new RelayV2BrokerCredentialStateStoreError(
      parsed?.code ?? "NATIVE_INTERFACE_INVALID",
    );
  } catch {
    return new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
  }
}

function isOpaqueNativeRevision(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

class NativeTransactionAdapter<TransactionScope>
implements RelayV2BrokerCredentialStateTransaction<TransactionScope> {
  readonly #store: NativeStoreAdapter;
  readonly #receiver: Record<string, unknown>;
  readonly #readMethod: (...args: unknown[]) => unknown;
  readonly #publishMethod: (...args: unknown[]) => unknown;
  readonly #revisions = new WeakMap<object, object>();
  #active = true;

  constructor(store: NativeStoreAdapter, raw: unknown) {
    const methods = snapshotExactDataRecord(raw, ["read", "compareAndPublish"]);
    if (methods === null) {
      throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    }
    const readMethod = methods.read;
    const publishMethod = methods.compareAndPublish;
    if (typeof readMethod !== "function" || typeof publishMethod !== "function") {
      throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    }
    this.#store = store;
    this.#receiver = raw as Record<string, unknown>;
    this.#readMethod = readMethod as (...args: unknown[]) => unknown;
    this.#publishMethod = publishMethod as (...args: unknown[]) => unknown;
  }

  expire(): void {
    this.#active = false;
  }

  #assertActive(): void {
    if (this.#store.terminalPoisoned) {
      throw new RelayV2BrokerCredentialStateStoreError("STORE_CLOSED");
    }
    if (!this.#active) {
      throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
    }
  }

  #issueRevision(raw: object): RelayV2BrokerCredentialStateRevision<TransactionScope> {
    const revision = Object.create(null) as RelayV2BrokerCredentialStateRevision<TransactionScope>;
    Object.defineProperty(revision, "toJSON", {
      value() {
        throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
      },
    });
    Object.freeze(revision);
    this.#revisions.set(revision, raw);
    return revision;
  }

  #decodeRead(value: unknown): RelayV2BrokerCredentialStateRead<TransactionScope> {
    this.#assertActive();
    const snapshot = snapshotOwnDataRecord(value);
    if (snapshot === null || typeof snapshot.outcome !== "string") {
      throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    }
    if (snapshot.outcome === "missing") {
      if (
        !hasExactKeys(snapshot, ["outcome", "revision"])
        || !isOpaqueNativeRevision(snapshot.revision)
      ) {
        throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
      }
      return Object.freeze({
        outcome: "missing",
        revision: this.#issueRevision(snapshot.revision),
      });
    }
    const copiedBytes = snapshot.outcome === "present"
      ? copyUint8Array(snapshot.bytes, RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES)
      : { status: "invalid" } as const;
    if (
      snapshot.outcome !== "present"
      || !hasExactKeys(snapshot, ["outcome", "revision", "bytes"])
      || !isOpaqueNativeRevision(snapshot.revision)
      || copiedBytes.status !== "copied"
    ) throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    return Object.freeze({
      outcome: "present",
      revision: this.#issueRevision(snapshot.revision),
      bytes: copiedBytes.bytes,
    });
  }

  read(): Promise<RelayV2BrokerCredentialStateRead<TransactionScope>> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(nativeOperationError(error));
    }
    let pending: unknown;
    try {
      pending = this.#readMethod.call(this.#receiver);
    } catch (error) {
      return Promise.reject(nativeOperationError(error));
    }
    return Promise.resolve(pending).then(
      (value) => {
        try {
          return this.#decodeRead(value);
        } catch (error) {
          throw nativeOperationError(error);
        }
      },
      (error) => { throw nativeOperationError(error); },
    );
  }

  compareAndPublish(
    expected: RelayV2BrokerCredentialStateRevision<TransactionScope>,
    next: Uint8Array,
  ): Promise<RelayV2BrokerCredentialStatePublish<TransactionScope>> {
    try {
      this.#assertActive();
    } catch (error) {
      return Promise.reject(nativeOperationError(error));
    }
    const rawExpected = this.#revisions.get(expected as object);
    if (rawExpected === undefined) {
      return Promise.reject(new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION"));
    }
    const copiedNext = copyUint8Array(
      next,
      RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
    );
    if (copiedNext.status === "invalid") {
      return Promise.reject(new RelayV2BrokerCredentialStateStoreError("INVALID_ARGUMENT"));
    }
    if (copiedNext.status === "too_large") {
      return Promise.reject(new RelayV2BrokerCredentialStateStoreError("STATE_TOO_LARGE"));
    }
    let pending: unknown;
    try {
      pending = this.#publishMethod.call(this.#receiver, rawExpected, copiedNext.bytes);
    } catch (error) {
      return Promise.reject(this.#store.mapPostPublishFailure(error));
    }
    return Promise.resolve(pending).then(
      (value): RelayV2BrokerCredentialStatePublish<TransactionScope> => {
        try {
          this.#assertActive();
          const snapshot = snapshotOwnDataRecord(value);
          if (snapshot === null || typeof snapshot.outcome !== "string") {
            throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
          }
          if (snapshot.outcome === "uncertain") {
            if (!hasExactKeys(snapshot, ["outcome"])) {
              throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
            }
            this.#store.terminalFence();
            return Object.freeze({ outcome: "uncertain" });
          }
          if (
            (snapshot.outcome !== "swapped"
              && snapshot.outcome !== "already_same"
              && snapshot.outcome !== "conflict")
            || !hasExactKeys(snapshot, ["outcome", "current"])
          ) throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
          const current = this.#decodeRead(snapshot.current);
          if (
            (snapshot.outcome === "swapped" || snapshot.outcome === "already_same")
            && current.outcome !== "present"
          ) throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
          return Object.freeze({ outcome: snapshot.outcome, current }) as
            RelayV2BrokerCredentialStatePublish<TransactionScope>;
        } catch (error) {
          this.#store.terminalFence();
          throw nativeOperationError(error);
        }
      },
      (error) => { throw this.#store.mapPostPublishFailure(error); },
    );
  }
}

class NativeStoreAdapter implements RelayV2BrokerCredentialStateStore {
  readonly #receiver: Record<string, unknown>;
  readonly #runMethod: (...args: unknown[]) => unknown;
  readonly #closeMethod: (...args: unknown[]) => unknown;
  #admissionClosed = false;
  #terminalPoisoned = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(raw: unknown) {
    const methods = snapshotExactDataRecord(raw, ["runExclusive", "close"]);
    if (methods === null) {
      throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    }
    const runMethod = methods.runExclusive;
    const closeMethod = methods.close;
    if (typeof runMethod !== "function" || typeof closeMethod !== "function") {
      throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
    }
    this.#receiver = raw as Record<string, unknown>;
    this.#runMethod = runMethod as (...args: unknown[]) => unknown;
    this.#closeMethod = closeMethod as (...args: unknown[]) => unknown;
  }

  get terminalPoisoned(): boolean {
    return this.#terminalPoisoned;
  }

  terminalFence(): void {
    this.#terminalPoisoned = true;
    this.#admissionClosed = true;
  }

  mapPostPublishFailure(error: unknown): RelayV2BrokerCredentialStateStoreError {
    const mapped = nativeOperationError(error);
    const code = snapshotOwnDataField(mapped, "code");
    if (
      typeof code !== "string"
      || !PUBLISH_PROVEN_NO_COMMIT_CODES.has(
        code as RelayV2BrokerCredentialStateStoreErrorCode,
      )
    ) {
      this.terminalFence();
    }
    return mapped;
  }

  runExclusive<Result>(
    operation: <TransactionScope>(
      transaction: RelayV2BrokerCredentialStateTransaction<TransactionScope>,
    ) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (this.#admissionClosed || this.#closed) {
      return Promise.reject(new RelayV2BrokerCredentialStateStoreError("STORE_CLOSED"));
    }
    let callbackInvoked = false;
    let callbackSettled = false;
    let protocolViolation = false;
    let operationSucceeded = false;
    let operationValue: Result;
    let operationError: unknown;
    const nativeCallback = async (rawTransaction: unknown): Promise<unknown> => {
      if (callbackInvoked) {
        protocolViolation = true;
        this.terminalFence();
        throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
      }
      if (this.#terminalPoisoned) {
        throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
      }
      callbackInvoked = true;
      let transaction: NativeTransactionAdapter<unknown>;
      try {
        transaction = new NativeTransactionAdapter(this, rawTransaction);
      } catch (error) {
        this.terminalFence();
        throw nativeOperationError(error);
      }
      try {
        operationValue = await operation(transaction);
        operationSucceeded = true;
      } catch (error) {
        operationError = error;
      } finally {
        transaction.expire();
        callbackSettled = true;
      }
      return undefined;
    };
    let pending: unknown;
    try {
      pending = this.#runMethod.call(this.#receiver, nativeCallback);
    } catch {
      this.terminalFence();
      return Promise.reject(
        new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID"),
      );
    }
    return Promise.resolve(pending).then(
      () => {
        if (!callbackInvoked || !callbackSettled || protocolViolation) {
          this.terminalFence();
          throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
        }
        if (!operationSucceeded) throw operationError;
        return operationValue;
      },
      () => {
        this.terminalFence();
        throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
      },
    );
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#admissionClosed = true;
    let pending: unknown;
    try {
      pending = this.#closeMethod.call(this.#receiver);
    } catch (error) {
      this.#closePromise = Promise.reject(nativeOperationError(error));
      return this.#closePromise;
    }
    this.#closePromise = Promise.resolve(pending).then(
      (value) => {
        if (value !== undefined) {
          throw new RelayV2BrokerCredentialStateStoreError("NATIVE_INTERFACE_INVALID");
        }
        this.#closed = true;
      },
      (error) => { throw nativeOperationError(error); },
    );
    return this.#closePromise;
  }
}

function parseOpenResult(
  value: unknown,
): RelayV2BrokerCredentialStateStoreOpenResult {
  const snapshot = snapshotOwnDataRecord(value);
  if (snapshot === null || typeof snapshot.status !== "string") {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
  if (snapshot.status === "unsupported") {
    const reason = parseUnsupported(snapshot);
    return reason === null
      ? Object.freeze({ status: "invalid", error: invalidFailure() })
      : Object.freeze({ status: "unsupported", reason });
  }
  if (snapshot.status === "invalid") {
    if (!hasExactKeys(snapshot, ["status", "error"])) {
      return Object.freeze({ status: "invalid", error: invalidFailure() });
    }
    const error = parseFailure(snapshot.error);
    return Object.freeze({ status: "invalid", error: error ?? invalidFailure() });
  }
  if (
    snapshot.status !== "opened"
    || !hasExactKeys(snapshot, ["status", "selfCheck", "store"])
    || snapshot.selfCheck !== "passed"
  ) return Object.freeze({ status: "invalid", error: invalidFailure() });
  const store = new NativeStoreAdapter(snapshot.store);
  return Object.freeze({ status: "opened", selfCheck: "passed", store });
}

export function parseRelayV2BrokerCredentialStateStoreOpenResult(
  value: unknown,
): RelayV2BrokerCredentialStateStoreOpenResult {
  try {
    return parseOpenResult(value);
  } catch {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
}

function bindingMethod(
  binding: unknown,
  name: keyof RelayV2BrokerCredentialStateNativeBinding,
): { receiver: Record<string, unknown>; method: (...args: unknown[]) => unknown } | null {
  const methods = snapshotExactDataRecord(binding, [
    "relayV2BrokerCredentialStateCapability",
    "openRelayV2BrokerCredentialStateStore",
  ]);
  if (methods === null) return null;
  const method = methods[name];
  if (typeof method !== "function") return null;
  return {
    receiver: binding as Record<string, unknown>,
    method: method as (...args: unknown[]) => unknown,
  };
}

/** Runtime-decodes one capability call. Raw throws and hostile getters close. */
export function readRelayV2BrokerCredentialStateStoreNativeCapability(
  binding: unknown,
): RelayV2BrokerCredentialStateStoreCapability {
  try {
    const selected = bindingMethod(binding, "relayV2BrokerCredentialStateCapability");
    if (selected === null) return Object.freeze({ status: "invalid", error: invalidFailure() });
    return parseRelayV2BrokerCredentialStateStoreCapability(
      selected.method.call(selected.receiver),
    );
  } catch {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
}

/**
 * Runtime-decodes one open call. The options object is exact, copied, and
 * frozen; this adapter never reads HOME and never accepts derived object paths.
 */
export async function openRelayV2BrokerCredentialStateStoreNativeBinding(
  binding: unknown,
  options: unknown,
): Promise<RelayV2BrokerCredentialStateStoreOpenResult> {
  const copiedOptions = snapshotOpenOptions(options);
  if (copiedOptions === null) {
    return Object.freeze({ status: "invalid", error: failure("INVALID_ARGUMENT") });
  }
  try {
    const selected = bindingMethod(binding, "openRelayV2BrokerCredentialStateStore");
    if (selected === null) return Object.freeze({ status: "invalid", error: invalidFailure() });
    return parseRelayV2BrokerCredentialStateStoreOpenResult(
      await selected.method.call(selected.receiver, copiedOptions),
    );
  } catch {
    return Object.freeze({ status: "invalid", error: invalidFailure() });
  }
}
