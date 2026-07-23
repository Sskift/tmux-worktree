import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
  type RelayV2HostCredentialAtomicByteCell,
  type RelayV2HostCredentialAtomicByteCellCasResult,
  type RelayV2HostCredentialAtomicByteCellRead,
  type RelayV2HostCredentialAtomicByteCellRevision,
  type RelayV2HostCredentialAtomicByteCellTransaction,
} from "./hostCredentialVault.js";

export const RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION = 1 as const;
export const RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_MAX_BYTES =
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES;
export const RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD =
  "openRelayV2HostCredentialAtomicFileCellV1" as const;

export type RelayV2HostCredentialAtomicFileCellNativeErrorCode =
  | "NATIVE_INTERFACE_INVALID"
  | "CELL_BUSY"
  | "CELL_CLOSED"
  | "CELL_CORRUPT"
  | "CELL_IDENTITY_UNCERTAIN"
  | "CELL_IO"
  | "CELL_PERMISSION_INVALID"
  | "CELL_DURABILITY_UNSUPPORTED"
  | "CELL_RECOVERY_REQUIRED"
  | "INVALID_ARGUMENT"
  | "INVALID_REVISION"
  | "VALUE_TOO_LARGE"
  | "REENTRANT"
  | "ASYNC_OPERATION_UNSUPPORTED"
  | "UNCERTAIN_FENCED";

const ERROR_MESSAGES: Readonly<Record<RelayV2HostCredentialAtomicFileCellNativeErrorCode, string>> =
  Object.freeze({
    NATIVE_INTERFACE_INVALID: "Relay v2 Host credential native cell interface is invalid",
    CELL_BUSY: "Relay v2 Host credential native cell is busy",
    CELL_CLOSED: "Relay v2 Host credential native cell is closed",
    CELL_CORRUPT: "Relay v2 Host credential native cell is corrupt",
    CELL_IDENTITY_UNCERTAIN: "Relay v2 Host credential native cell identity is uncertain",
    CELL_IO: "Relay v2 Host credential native cell I/O failed",
    CELL_PERMISSION_INVALID: "Relay v2 Host credential native cell permissions are invalid",
    CELL_DURABILITY_UNSUPPORTED: "Relay v2 Host credential native cell durability is unsupported",
    CELL_RECOVERY_REQUIRED: "Relay v2 Host credential native cell requires recovery",
    INVALID_ARGUMENT: "Relay v2 Host credential native cell argument is invalid",
    INVALID_REVISION: "Relay v2 Host credential native cell revision is invalid",
    VALUE_TOO_LARGE: "Relay v2 Host credential native cell value exceeds the frozen limit",
    REENTRANT: "Relay v2 Host credential native cell rejects reentrant access",
    ASYNC_OPERATION_UNSUPPORTED: "Relay v2 Host credential native cell operation must be synchronous",
    UNCERTAIN_FENCED: "Relay v2 Host credential native cell is fenced after an uncertain commit",
  });

const RAW_ERROR_CODES = new Set<RelayV2HostCredentialAtomicFileCellNativeErrorCode>([
  "NATIVE_INTERFACE_INVALID",
  "CELL_BUSY",
  "CELL_CLOSED",
  "CELL_CORRUPT",
  "CELL_IDENTITY_UNCERTAIN",
  "CELL_IO",
  "CELL_PERMISSION_INVALID",
  "CELL_DURABILITY_UNSUPPORTED",
  "CELL_RECOVERY_REQUIRED",
  "INVALID_ARGUMENT",
  "INVALID_REVISION",
  "VALUE_TOO_LARGE",
]);

const TERMINAL_RAW_ERROR_CODES = new Set<RelayV2HostCredentialAtomicFileCellNativeErrorCode>([
  "CELL_CLOSED",
  "CELL_CORRUPT",
  "CELL_IDENTITY_UNCERTAIN",
  "CELL_PERMISSION_INVALID",
  "CELL_DURABILITY_UNSUPPORTED",
  "CELL_RECOVERY_REQUIRED",
]);

export class RelayV2HostCredentialAtomicFileCellNativeError extends Error {
  constructor(readonly code: RelayV2HostCredentialAtomicFileCellNativeErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostCredentialAtomicFileCellNativeError";
  }
}

export interface RelayV2HostCredentialAtomicFileCellNativeOptions {
  readonly nativeModule: unknown;
}

export interface RelayV2HostCredentialAtomicFileCellNative
extends RelayV2HostCredentialAtomicByteCell {
  closeAndDrain(): Promise<void>;
}

type JsonObject = Record<string, unknown>;
type RawMethod = (...args: unknown[]) => unknown;
type Lifecycle = "open" | "fenced" | "closing" | "closed";

interface CapturedMethod {
  readonly receiver: JsonObject;
  readonly method: RawMethod;
}

interface CapturedHandle {
  readonly receiver: JsonObject;
  readonly read: RawMethod;
  readonly compareAndSwap: RawMethod;
  readonly close: RawMethod;
}

interface RawSnapshot {
  readonly bytes: Uint8Array | null;
  readonly revision: object;
}

interface RevisionRecord {
  readonly owner: NativeCellOwner;
  readonly nativeRevision: object;
  current: boolean;
  consumed: boolean;
}

const publicRevisions = new WeakMap<object, RevisionRecord>();
// Permanent raw-handle identity claim: only one NativeCellOwner may ever own a
// captured handle receiver. This registry lives only in this module, which is
// its own canonical tsup entry and external for the single importing bridge
// entry, so exactly one copy exists per process. The claim is never released,
// on success or failure.
const claimedRawHandleIdentities = new WeakSet<object>();
const FUNCTION_PROTOTYPE_CALL = Function.prototype.call;
const FUNCTION_PROTOTYPE_APPLY = Function.prototype.apply;
const REFLECT_APPLY = Reflect.apply;
const PROMISE_PROTOTYPE_THEN = Promise.prototype.then;
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

function callCapturedFunction(
  method: RawMethod,
  receiver: unknown,
  ...args: unknown[]
): unknown {
  return REFLECT_APPLY(FUNCTION_PROTOTYPE_CALL, method, [receiver, ...args]);
}

function applyCapturedFunction(
  method: RawMethod,
  receiver: unknown,
  args: readonly unknown[],
): unknown {
  return REFLECT_APPLY(FUNCTION_PROTOTYPE_APPLY, method, [receiver, args]);
}

function fail(code: RelayV2HostCredentialAtomicFileCellNativeErrorCode): never {
  throw new RelayV2HostCredentialAtomicFileCellNativeError(code);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const expected = new Set(keys);
  return actual.length === keys.length
    && actual.every((key) => expected.has(key as string));
}

function snapshotOwnDataRecord(value: unknown): Readonly<JsonObject> | null {
  try {
    if (!isRecord(value) || nodeUtilTypes.isProxy(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return null;
    const snapshot: JsonObject = Object.create(null);
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
): Readonly<JsonObject> | null {
  const snapshot = snapshotOwnDataRecord(value);
  return snapshot !== null && hasExactKeys(snapshot as JsonObject, keys) ? snapshot : null;
}

function isNativeAsyncFunction(value: RawMethod): boolean {
  try {
    return nodeUtilTypes.isProxy(value) || nodeUtilTypes.isAsyncFunction(value);
  } catch {
    return true;
  }
}

function isAsynchronousResultWithoutAssimilation(value: unknown): boolean {
  try {
    if (nodeUtilTypes.isPromise(value)) {
      void callCapturedFunction(PROMISE_PROTOTYPE_THEN, value, undefined, () => undefined);
      return true;
    }
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      return false;
    }
    let current: object | null = value as object;
    while (current !== null) {
      if (nodeUtilTypes.isProxy(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, "then");
      if (descriptor !== undefined) {
        return descriptor.get !== undefined || typeof descriptor.value === "function";
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return false;
  } catch {
    return true;
  }
}

type Uint8ArrayCopyResult =
  | { readonly outcome: "copied"; readonly bytes: Uint8Array }
  | { readonly outcome: "invalid" }
  | { readonly outcome: "too_large" };

function copyUint8Array(value: unknown): Uint8ArrayCopyResult {
  try {
    if (!ArrayBuffer.isView(value) || nodeUtilTypes.isProxy(value)) return { outcome: "invalid" };
    if (applyCapturedFunction(TYPED_ARRAY_TAG_GETTER, value, []) !== "Uint8Array") {
      return { outcome: "invalid" };
    }
    const length = applyCapturedFunction(TYPED_ARRAY_LENGTH_GETTER, value, []);
    const buffer = applyCapturedFunction(TYPED_ARRAY_BUFFER_GETTER, value, []);
    if (!Number.isSafeInteger(length)
      || length < 0
      || !(buffer instanceof ArrayBuffer)) return { outcome: "invalid" };
    if (length > RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_MAX_BYTES) {
      return { outcome: "too_large" };
    }
    const copied = new Uint8Array(length);
    applyCapturedFunction(UINT8_ARRAY_SET, copied, [value]);
    return { outcome: "copied", bytes: copied };
  } catch {
    return { outcome: "invalid" };
  }
}

function isOpaqueNativeRevision(value: unknown): value is object {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return !isAsynchronousResultWithoutAssimilation(value);
}

function frozenRecord<T extends object>(fields: Record<string, unknown>): T {
  const result = Object.create(null) as T;
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  return Object.freeze(result);
}

function frozenMethodPort<T extends object>(methods: Record<string, RawMethod>): T {
  const result = Object.create(null) as T;
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(result, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: method,
    });
  }
  return Object.freeze(result);
}

function request(operation: "open" | "read" | "close"): Readonly<JsonObject> {
  return frozenRecord({
    abiVersion: RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION,
    operation,
  });
}

function compareRequest(nativeRevision: object, bytes: Uint8Array): Readonly<JsonObject> {
  return frozenRecord({
    abiVersion: RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION,
    operation: "compare_and_swap",
    revision: nativeRevision,
    bytes,
  });
}

function captureMethodRecord(value: unknown, keys: readonly string[]): Readonly<JsonObject> | null {
  const snapshot = snapshotExactDataRecord(value, keys);
  if (snapshot === null) return null;
  for (const key of keys) {
    const method = snapshot[key];
    if (typeof method !== "function" || isNativeAsyncFunction(method as RawMethod)) return null;
  }
  return snapshot;
}

function captureModule(value: unknown): CapturedMethod | null {
  const snapshot = captureMethodRecord(
    value,
    [RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD],
  );
  if (snapshot === null) return null;
  return {
    receiver: value as JsonObject,
    method: snapshot[RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_OPEN_METHOD] as RawMethod,
  };
}

function captureCleanupClose(value: unknown): CapturedMethod | null {
  try {
    if (!isRecord(value) || nodeUtilTypes.isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "close");
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    const close = descriptor.value;
    if (typeof close !== "function" || isNativeAsyncFunction(close as RawMethod)) return null;
    return { receiver: value, method: close as RawMethod };
  } catch {
    return null;
  }
}

function captureHandle(value: unknown): CapturedHandle | null {
  const snapshot = captureMethodRecord(value, ["read", "compareAndSwap", "close"]);
  if (snapshot === null) return null;
  return {
    receiver: value as JsonObject,
    read: snapshot.read as RawMethod,
    compareAndSwap: snapshot.compareAndSwap as RawMethod,
    close: snapshot.close as RawMethod,
  };
}

function invokeSynchronous(method: CapturedMethod, input: Readonly<JsonObject>): unknown {
  const result = applyCapturedFunction(method.method, method.receiver, [input]);
  if (isAsynchronousResultWithoutAssimilation(result)) {
    return fail("NATIVE_INTERFACE_INVALID");
  }
  return result;
}

function invokeHandleSynchronous(
  handle: CapturedHandle,
  method: "read" | "compareAndSwap" | "close",
  input: Readonly<JsonObject>,
): unknown {
  const result = applyCapturedFunction(handle[method], handle.receiver, [input]);
  if (isAsynchronousResultWithoutAssimilation(result)) {
    return fail("NATIVE_INTERFACE_INVALID");
  }
  return result;
}

function parseRawError(value: unknown): RelayV2HostCredentialAtomicFileCellNativeErrorCode | null {
  const snapshot = snapshotExactDataRecord(value, ["code"]);
  if (snapshot === null
    || typeof snapshot.code !== "string"
    || !RAW_ERROR_CODES.has(snapshot.code as RelayV2HostCredentialAtomicFileCellNativeErrorCode)) {
    return null;
  }
  return snapshot.code as RelayV2HostCredentialAtomicFileCellNativeErrorCode;
}

function parseResultPrefix(
  value: unknown,
  operation: "open" | "read" | "compare_and_swap" | "close",
): Readonly<JsonObject> | null {
  const snapshot = snapshotOwnDataRecord(value);
  if (snapshot === null
    || snapshot.abiVersion !== RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_NATIVE_ABI_VERSION
    || snapshot.operation !== operation
    || typeof snapshot.outcome !== "string") return null;
  return snapshot;
}

function parseErrorResult(
  snapshot: Readonly<JsonObject>,
  keys: readonly string[],
): RelayV2HostCredentialAtomicFileCellNativeErrorCode | null {
  if (snapshot.outcome !== "error"
    || !hasExactKeys(snapshot as JsonObject, keys)) return null;
  return parseRawError(snapshot.error);
}

function parseRawSnapshot(value: unknown): RawSnapshot | null {
  const snapshot = snapshotOwnDataRecord(value);
  if (snapshot === null || typeof snapshot.state !== "string") return null;
  if (snapshot.state === "empty") {
    if (!hasExactKeys(snapshot as JsonObject, ["state", "revision"])
      || !isOpaqueNativeRevision(snapshot.revision)) return null;
    return { bytes: null, revision: snapshot.revision };
  }
  if (snapshot.state !== "present"
    || !hasExactKeys(snapshot as JsonObject, ["state", "revision", "bytes"])
    || !isOpaqueNativeRevision(snapshot.revision)) return null;
  const bytes = copyUint8Array(snapshot.bytes);
  return bytes.outcome === "copied"
    ? { bytes: bytes.bytes, revision: snapshot.revision }
    : null;
}

function cleanupUnpublishedHandle(handle: unknown): void {
  const close = captureCleanupClose(handle);
  if (close === null) return;
  try {
    const result = invokeSynchronous(close, request("close"));
    const snapshot = parseResultPrefix(result, "close");
    if (snapshot === null
      || snapshot.outcome !== "closed"
      || !hasExactKeys(snapshot as JsonObject, ["abiVersion", "operation", "outcome"])) return;
  } catch {
    // The wrapper never reflects cleanup errors from an unpublished handle.
  }
}

class NativeCellOwner {
  readonly #handle: CapturedHandle;
  #lifecycle: Lifecycle = "open";
  #operationActive = false;
  #admitted = 0;
  #currentRevision: RevisionRecord | null = null;
  #closeStarted = false;
  #closePromise: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;
  #rejectClose: ((error: unknown) => void) | null = null;

  constructor(handle: CapturedHandle) {
    this.#handle = handle;
  }

  runExclusive<T>(
    operation: (transaction: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T {
    if (this.#operationActive) return fail("REENTRANT");
    this.#assertOperationAllowed();
    if (typeof operation !== "function") return fail("INVALID_ARGUMENT");
    if (isNativeAsyncFunction(operation as RawMethod)) {
      return fail("ASYNC_OPERATION_UNSUPPORTED");
    }

    this.#operationActive = true;
    this.#admitted += 1;
    let transactionActive = true;
    const transaction = frozenMethodPort<RelayV2HostCredentialAtomicByteCellTransaction>({
      read: (() => {
        if (!transactionActive) return fail("CELL_CLOSED");
        return this.#read();
      }) as RawMethod,
      compareAndSwap: ((
        expected: RelayV2HostCredentialAtomicByteCellRevision,
        replacement: Uint8Array,
      ) => {
        if (!transactionActive) return fail("CELL_CLOSED");
        return this.#compareAndSwap(expected, replacement);
      }) as RawMethod,
    });
    try {
      const result = operation(transaction);
      if (isAsynchronousResultWithoutAssimilation(result)) {
        this.#terminalFence();
        return fail("ASYNC_OPERATION_UNSUPPORTED");
      }
      return result;
    } finally {
      transactionActive = false;
      this.#operationActive = false;
      this.#admitted -= 1;
      this.#settleCloseIfReady();
    }
  }

  closeAndDrain(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#lifecycle = "closing";
    this.#invalidateCurrentRevision();
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });
    this.#settleCloseIfReady();
    return this.#closePromise;
  }

  #assertOperationAllowed(): void {
    if (this.#lifecycle === "fenced") return fail("UNCERTAIN_FENCED");
    if (this.#lifecycle !== "open") return fail("CELL_CLOSED");
  }

  #terminalFence(): void {
    if (this.#lifecycle === "open") this.#lifecycle = "fenced";
    this.#invalidateCurrentRevision();
  }

  #invalidateCurrentRevision(): void {
    if (this.#currentRevision !== null) this.#currentRevision.current = false;
    this.#currentRevision = null;
  }

  #mapRawError(code: RelayV2HostCredentialAtomicFileCellNativeErrorCode): never {
    if (TERMINAL_RAW_ERROR_CODES.has(code)) this.#terminalFence();
    return fail(code);
  }

  #invoke(method: "read" | "compareAndSwap", input: Readonly<JsonObject>): unknown {
    try {
      return invokeHandleSynchronous(this.#handle, method, input);
    } catch {
      this.#terminalFence();
      return fail("NATIVE_INTERFACE_INVALID");
    }
  }

  #read(): RelayV2HostCredentialAtomicByteCellRead {
    this.#assertOperationAllowed();
    const raw = this.#invoke("read", request("read"));
    const snapshot = parseResultPrefix(raw, "read");
    if (snapshot === null) {
      this.#terminalFence();
      return fail("NATIVE_INTERFACE_INVALID");
    }
    const error = parseErrorResult(
      snapshot,
      ["abiVersion", "operation", "outcome", "error"],
    );
    if (snapshot.outcome === "error") {
      if (error === null) {
        this.#terminalFence();
        return fail("NATIVE_INTERFACE_INVALID");
      }
      return this.#mapRawError(error);
    }
    if (snapshot.outcome !== "ok"
      || !hasExactKeys(snapshot as JsonObject, ["abiVersion", "operation", "outcome", "current"])) {
      this.#terminalFence();
      return fail("NATIVE_INTERFACE_INVALID");
    }
    const current = parseRawSnapshot(snapshot.current);
    if (current === null) {
      this.#terminalFence();
      return fail("NATIVE_INTERFACE_INVALID");
    }
    return this.#issueRead(current);
  }

  #issueRead(current: RawSnapshot): RelayV2HostCredentialAtomicByteCellRead {
    this.#invalidateCurrentRevision();
    const revision = Object.freeze(Object.create(null)) as RelayV2HostCredentialAtomicByteCellRevision;
    const record: RevisionRecord = {
      owner: this,
      nativeRevision: current.revision,
      current: true,
      consumed: false,
    };
    publicRevisions.set(revision as object, record);
    this.#currentRevision = record;
    return frozenRecord({
      bytes: current.bytes === null ? null : Uint8Array.from(current.bytes),
      revision,
    });
  }

  #compareAndSwap(
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    replacementValue: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult {
    this.#assertOperationAllowed();
    const record = (typeof expected === "object" && expected !== null)
      ? publicRevisions.get(expected as object)
      : undefined;
    if (record === undefined
      || record.owner !== this
      || record !== this.#currentRevision
      || !record.current
      || record.consumed) return fail("INVALID_REVISION");
    const replacement = copyUint8Array(replacementValue);
    if (replacement.outcome === "invalid") return fail("INVALID_ARGUMENT");
    if (replacement.outcome === "too_large") return fail("VALUE_TOO_LARGE");

    record.consumed = true;
    record.current = false;
    this.#currentRevision = null;
    const raw = this.#invoke(
      "compareAndSwap",
      compareRequest(record.nativeRevision, replacement.bytes),
    );
    const snapshot = parseResultPrefix(raw, "compare_and_swap");
    if (snapshot === null) {
      this.#terminalFence();
      return fail("NATIVE_INTERFACE_INVALID");
    }
    const baseKeys = ["abiVersion", "operation", "outcome"];
    if (snapshot.outcome === "swapped"
      && hasExactKeys(snapshot as JsonObject, baseKeys)) {
      return frozenRecord({ status: "swapped" });
    }
    if (snapshot.outcome === "uncertain"
      && hasExactKeys(snapshot as JsonObject, baseKeys)) {
      this.#terminalFence();
      return frozenRecord({ status: "uncertain" });
    }
    if (snapshot.outcome === "conflict"
      && hasExactKeys(snapshot as JsonObject, [...baseKeys, "current"])) {
      const current = parseRawSnapshot(snapshot.current);
      if (current !== null) {
        return frozenRecord({ status: "conflict", current: this.#issueRead(current) });
      }
    }
    if (snapshot.outcome === "error") {
      const error = parseErrorResult(snapshot, [...baseKeys, "error"]);
      if (error !== null) return this.#mapRawError(error);
    }
    this.#terminalFence();
    return fail("NATIVE_INTERFACE_INVALID");
  }

  #settleCloseIfReady(): void {
    if (this.#lifecycle !== "closing" || this.#admitted !== 0 || this.#closeStarted) return;
    this.#closeStarted = true;
    let error: RelayV2HostCredentialAtomicFileCellNativeError | null = null;
    try {
      const raw = invokeHandleSynchronous(this.#handle, "close", request("close"));
      const snapshot = parseResultPrefix(raw, "close");
      if (snapshot === null
        || snapshot.outcome !== "closed"
        || !hasExactKeys(snapshot as JsonObject, ["abiVersion", "operation", "outcome"])) {
        const rawError = snapshot === null
          ? null
          : parseErrorResult(
            snapshot,
            ["abiVersion", "operation", "outcome", "error"],
          );
        error = new RelayV2HostCredentialAtomicFileCellNativeError(
          rawError ?? "NATIVE_INTERFACE_INVALID",
        );
      }
    } catch {
      error = new RelayV2HostCredentialAtomicFileCellNativeError(
        "NATIVE_INTERFACE_INVALID",
      );
    }
    this.#lifecycle = "closed";
    const resolve = this.#resolveClose;
    const reject = this.#rejectClose;
    this.#resolveClose = null;
    this.#rejectClose = null;
    if (error === null) resolve?.();
    else reject?.(error);
  }
}

function parseOpenedHandle(raw: unknown): CapturedHandle {
  const rawRecord = snapshotOwnDataRecord(raw);
  const snapshot = parseResultPrefix(raw, "open");
  const possibleHandle = rawRecord?.handle;
  if (snapshot === null) {
    cleanupUnpublishedHandle(possibleHandle);
    return fail("NATIVE_INTERFACE_INVALID");
  }
  if (snapshot.outcome === "error") {
    const error = parseErrorResult(
      snapshot,
      ["abiVersion", "operation", "outcome", "error"],
    );
    if (error === null) {
      cleanupUnpublishedHandle(possibleHandle);
      return fail("NATIVE_INTERFACE_INVALID");
    }
    return fail(error);
  }
  if (snapshot.outcome !== "opened"
    || !hasExactKeys(snapshot as JsonObject, ["abiVersion", "operation", "outcome", "handle"])) {
    cleanupUnpublishedHandle(possibleHandle);
    return fail("NATIVE_INTERFACE_INVALID");
  }
  const handle = captureHandle(snapshot.handle);
  if (handle === null) {
    cleanupUnpublishedHandle(snapshot.handle);
    return fail("NATIVE_INTERFACE_INVALID");
  }
  return handle;
}

/**
 * Default-off, injected-only closed wrapper for the Host credential cell ABI.
 * It never loads an addon and never reads a path, HOME, environment, process,
 * network, credential envelope, broker store, or fallback source.
 */
export function openRelayV2HostCredentialAtomicFileCellNative(
  options: RelayV2HostCredentialAtomicFileCellNativeOptions,
): RelayV2HostCredentialAtomicFileCellNative {
  const copiedOptions = snapshotExactDataRecord(options, ["nativeModule"]);
  if (copiedOptions === null) return fail("INVALID_ARGUMENT");
  const module = captureModule(copiedOptions.nativeModule);
  if (module === null) return fail("NATIVE_INTERFACE_INVALID");

  let rawOpen: unknown;
  try {
    rawOpen = invokeSynchronous(module, request("open"));
  } catch {
    return fail("NATIVE_INTERFACE_INVALID");
  }
  const handle = parseOpenedHandle(rawOpen);
  // Synchronous, atomic, permanent claim on the captured handle receiver,
  // recorded at the parse/open publication boundary immediately before the
  // owner is constructed. A duplicate raw handle fails closed as busy and is
  // NEVER cleaned up or closed here: it already belongs to the first owner.
  if (claimedRawHandleIdentities.has(handle.receiver)) return fail("CELL_BUSY");
  claimedRawHandleIdentities.add(handle.receiver);
  const owner = new NativeCellOwner(handle);
  try {
    return frozenMethodPort<RelayV2HostCredentialAtomicFileCellNative>({
      runExclusive: owner.runExclusive.bind(owner) as RawMethod,
      closeAndDrain: owner.closeAndDrain.bind(owner) as RawMethod,
    });
  } catch {
    cleanupUnpublishedHandle(handle.receiver);
    return fail("NATIVE_INTERFACE_INVALID");
  }
}
