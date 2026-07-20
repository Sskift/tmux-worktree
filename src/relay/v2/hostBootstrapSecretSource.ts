import { Buffer } from "node:buffer";
import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2HostBootstrapSecretPrivilegedIntakePort,
} from "./hostBootstrapSecretHandoff.js";

type RelayV2HostBootstrapSecretSourceCandidate = ReturnType<
RelayV2HostBootstrapSecretPrivilegedIntakePort["accept"]
>;

export const RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS = Object.freeze({
  maxPayloadBytes: 8_192,
  maxRawBytes: 8_193,
});

export interface RelayV2HostBootstrapSecretByteSource
extends AsyncIterable<Uint8Array> {
  cancel(): void | Promise<void>;
}

export interface RelayV2HostBootstrapSecretSourceHandle {
  readCandidate(): Promise<RelayV2HostBootstrapSecretSourceCandidate>;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostBootstrapSecretSourceErrorCode =
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INVALID"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_ALREADY_CLAIMED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_INVALID"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostBootstrapSecretSourceErrorCode,
string
>> = Object.freeze({
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INVALID:
    "Relay v2 host bootstrap secret byte source is invalid",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_ALREADY_CLAIMED:
    "Relay v2 host bootstrap secret byte source is already claimed",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_INVALID:
    "Relay v2 host bootstrap secret privileged intake is invalid",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED:
    "Relay v2 host bootstrap secret byte source failed",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID:
    "Relay v2 host bootstrap secret record is invalid",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED:
    "Relay v2 host bootstrap secret byte source cancellation failed",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED:
    "Relay v2 host bootstrap secret privileged intake rejected the record",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED:
    "Relay v2 host bootstrap secret source is closed",
});

export class RelayV2HostBootstrapSecretSourceError extends Error {
  constructor(readonly code: RelayV2HostBootstrapSecretSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostBootstrapSecretSourceError";
  }
}

interface CapturedMethod {
  receiver: object;
  method: Function;
}

interface CapturedSource {
  receiver: object;
  openIterator: Function;
  cancel: Function;
}

interface CapturedIterator {
  receiver: object;
  next: Function;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type Lifecycle =
  | "open"
  | "reading"
  | "committing"
  | "committed"
  | "failed"
  | "closing"
  | "closed";

const claimedSources = new WeakSet<object>();
const promisePrototypeThen = Promise.prototype.then;
const scheduleMicrotask = queueMicrotask;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const uint8ArraySet = Uint8Array.prototype.set;
const uint8ArrayFill = Uint8Array.prototype.fill;
const bufferFrom = Buffer.from;
const bufferToString = Buffer.prototype.toString;

function sourceError(
  code: RelayV2HostBootstrapSecretSourceErrorCode,
): RelayV2HostBootstrapSecretSourceError {
  return new RelayV2HostBootstrapSecretSourceError(code);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function observeRejection(promise: Promise<unknown>): void {
  try {
    void Reflect.apply(promisePrototypeThen, promise, [
      undefined,
      () => undefined,
    ]);
  } catch {
    // All promises created by this owner are canonical native promises. This
    // branch is only a last-resort guard against ambient prototype tampering.
  }
}

function captureDataMethod(value: object, key: PropertyKey): Function | null {
  try {
    let owner: object | null = value;
    while (owner !== null) {
      if (nodeUtilTypes.isProxy(owner)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor)
          || typeof descriptor.value !== "function"
          || nodeUtilTypes.isProxy(descriptor.value)) {
          return null;
        }
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function captureSource(value: unknown): CapturedSource {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INVALID");
  }
  if (claimedSources.has(value)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_ALREADY_CLAIMED");
  }
  const openIterator = captureDataMethod(value, Symbol.asyncIterator);
  const cancel = captureDataMethod(value, "cancel");
  if (openIterator === null || cancel === null) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INVALID");
  }
  return { receiver: value, openIterator, cancel };
}

function captureIntake(value: unknown): CapturedMethod {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_INVALID");
  }
  const method = captureDataMethod(value, "accept");
  if (method === null) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_INVALID");
  }
  return { receiver: value, method };
}

function captureIterator(value: unknown): CapturedIterator {
  if ((typeof value !== "object" && typeof value !== "function")
    || value === null
    || nodeUtilTypes.isProxy(value)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  const next = captureDataMethod(value, "next");
  if (next === null) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  return { receiver: value as object, next };
}

function requireNativePromise(
  value: unknown,
  code: RelayV2HostBootstrapSecretSourceErrorCode,
): Promise<unknown> {
  try {
    if (!nodeUtilTypes.isPromise(value)
      || nodeUtilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Promise.prototype
      || Object.getOwnPropertyDescriptor(value as object, "constructor") !== undefined
      || Object.getOwnPropertyDescriptor(value as object, "then") !== undefined) {
      throw sourceError(code);
    }
  } catch {
    throw sourceError(code);
  }
  return value as Promise<unknown>;
}

function requireHandoffCandidate(
  value: unknown,
): RelayV2HostBootstrapSecretSourceCandidate {
  try {
    if (typeof value !== "object"
      || value === null
      || nodeUtilTypes.isProxy(value)
      || nodeUtilTypes.isPromise(value)) {
      throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED");
    }
    let owner: object | null = value;
    while (owner !== null) {
      if (nodeUtilTypes.isProxy(owner)
        || Object.getOwnPropertyDescriptor(owner, "then") !== undefined) {
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED");
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED");
  }
  return value as RelayV2HostBootstrapSecretSourceCandidate;
}

function iteratorResult(value: unknown): IteratorResult<unknown> {
  if (typeof value !== "object" || value === null || nodeUtilTypes.isProxy(value)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  let doneDescriptor: PropertyDescriptor | undefined;
  let valueDescriptor: PropertyDescriptor | undefined;
  try {
    doneDescriptor = Object.getOwnPropertyDescriptor(value, "done");
    valueDescriptor = Object.getOwnPropertyDescriptor(value, "value");
  } catch {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  if (doneDescriptor === undefined
    || !("value" in doneDescriptor)
    || typeof doneDescriptor.value !== "boolean") {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  if (doneDescriptor.value) return { done: true, value: undefined };
  if (valueDescriptor === undefined || !("value" in valueDescriptor)) {
    throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
  }
  return { done: false, value: valueDescriptor.value };
}

function copyChunk(value: unknown, remainingRawBytes: number): Uint8Array | null {
  if (nodeUtilTypes.isProxy(value) || !nodeUtilTypes.isUint8Array(value)) return null;
  try {
    const buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    if (!(buffer instanceof ArrayBuffer)
      || byteLength === 0
      || byteLength > remainingRawBytes) {
      return null;
    }
    const copied = new Uint8Array(byteLength);
    Reflect.apply(uint8ArraySet, copied, [value]);
    return copied;
  } catch {
    return null;
  }
}

function clearBytes(bytes: Uint8Array): void {
  try {
    Reflect.apply(uint8ArrayFill, bytes, [0]);
  } catch {
    // Owner-created Uint8Arrays cannot normally fail to clear.
  }
}

function frozenHandle(
  readCandidate: () => Promise<RelayV2HostBootstrapSecretSourceCandidate>,
  closeAndDrain: () => Promise<void>,
): RelayV2HostBootstrapSecretSourceHandle {
  const handle = Object.create(null) as RelayV2HostBootstrapSecretSourceHandle;
  Object.defineProperties(handle, {
    readCandidate: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: readCandidate,
    },
    closeAndDrain: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: closeAndDrain,
    },
  });
  return Object.freeze(handle);
}

/**
 * Default-off adapter for one injected bootstrap-secret byte source. It owns
 * only source claim, bounded one-record framing, source cancellation, and its
 * read/close barrier. H-Cred2 remains the semantic token and candidate owner.
 */
export function createRelayV2HostBootstrapSecretSource(
  byteSource: RelayV2HostBootstrapSecretByteSource,
  privilegedIntake: RelayV2HostBootstrapSecretPrivilegedIntakePort,
): RelayV2HostBootstrapSecretSourceHandle {
  let source: CapturedSource | null = captureSource(byteSource);
  let intake: CapturedMethod | null = captureIntake(privilegedIntake);
  claimedSources.add(source.receiver);

  let lifecycle: Lifecycle = "open";
  let iterator: CapturedIterator | null = null;
  let readPromise: Promise<RelayV2HostBootstrapSecretSourceCandidate> | null = null;
  let readDrainPromise: Promise<void> | null = null;
  let cancelPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let terminalFailure: RelayV2HostBootstrapSecretSourceErrorCode | null = null;
  const payload = new Uint8Array(
    RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS.maxPayloadBytes,
  );
  let payloadBytes = 0;
  let rawBytes = 0;
  let sawTerminalLf = false;

  const clearMutableState = (): void => {
    clearBytes(payload);
    payloadBytes = 0;
    rawBytes = 0;
    sawTerminalLf = false;
  };

  const closedError = (): RelayV2HostBootstrapSecretSourceError => (
    sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED")
  );

  const ensureReading = (): void => {
    if (lifecycle !== "reading") throw closedError();
  };

  const recordFailure = (error: RelayV2HostBootstrapSecretSourceError): void => {
    if (error.code === "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CLOSED") return;
    if (error.code === "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED") {
      terminalFailure = error.code;
    } else {
      terminalFailure ??= error.code;
    }
    if (lifecycle !== "closing" && lifecycle !== "closed") lifecycle = "failed";
  };

  const beginCancel = (): Promise<void> => {
    if (cancelPromise !== null) return cancelPromise;
    const cancellation = deferred<void>();
    cancelPromise = cancellation.promise;
    observeRejection(cancelPromise);
    scheduleMicrotask(() => {
      const captured = source;
      if (captured === null) {
        cancellation.resolve(undefined);
        return;
      }
      let result: unknown;
      try {
        result = Reflect.apply(captured.cancel, captured.receiver, []);
      } catch {
        const error = sourceError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
        );
        recordFailure(error);
        cancellation.reject(error);
        return;
      }
      if (result === undefined) {
        cancellation.resolve(undefined);
        return;
      }
      let promise: Promise<unknown>;
      try {
        promise = requireNativePromise(
          result,
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
        );
        if (promise === closePromise || promise === readPromise) {
          throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED");
        }
      } catch {
        const error = sourceError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
        );
        recordFailure(error);
        cancellation.reject(error);
        return;
      }
      try {
        void Reflect.apply(promisePrototypeThen, promise, [
          () => cancellation.resolve(undefined),
          () => {
            const error = sourceError(
              "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
            );
            recordFailure(error);
            cancellation.reject(error);
          },
        ]);
      } catch {
        const error = sourceError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
        );
        recordFailure(error);
        cancellation.reject(error);
      }
    });
    return cancelPromise;
  };

  const appendChunk = (chunk: Uint8Array): void => {
    rawBytes += chunk.byteLength;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index]!;
      if (sawTerminalLf) {
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID");
      }
      if (byte === 0x0a) {
        if (payloadBytes === 0) {
          throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID");
        }
        sawTerminalLf = true;
        continue;
      }
      if (byte === 0x00 || byte === 0x0d || byte > 0x7f
        || payloadBytes === payload.byteLength) {
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID");
      }
      payload[payloadBytes] = byte;
      payloadBytes += 1;
    }
  };

  const readAndCommit = async (): Promise<RelayV2HostBootstrapSecretSourceCandidate> => {
    ensureReading();
    const capturedSource = source!;
    let opened: unknown;
    try {
      opened = Reflect.apply(
        capturedSource.openIterator,
        capturedSource.receiver,
        [],
      );
    } catch {
      if (lifecycle !== "reading") throw closedError();
      throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
    }
    ensureReading();
    iterator = captureIterator(opened);

    while (true) {
      ensureReading();
      let nextResult: unknown;
      try {
        nextResult = Reflect.apply(iterator.next, iterator.receiver, []);
      } catch {
        if (lifecycle !== "reading") throw closedError();
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
      }
      ensureReading();
      let nextPromise: Promise<unknown>;
      try {
        nextPromise = requireNativePromise(
          nextResult,
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED",
        );
        if (nextPromise === readPromise || nextPromise === closePromise) {
          throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
        }
      } catch {
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
      }
      let settled: unknown;
      try {
        settled = await nextPromise;
      } catch {
        if (lifecycle !== "reading") throw closedError();
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
      }
      ensureReading();
      const item = iteratorResult(settled);
      if (item.done) break;

      const remaining = RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_LIMITS.maxRawBytes
        - rawBytes;
      const chunk = copyChunk(item.value, remaining);
      if (chunk === null) {
        throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID");
      }
      try {
        appendChunk(chunk);
      } finally {
        clearBytes(chunk);
      }
    }

    if (payloadBytes === 0) {
      throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_RECORD_INVALID");
    }

    await beginCancel();
    ensureReading();
    lifecycle = "committing";

    let secret: string | null = null;
    let view: Buffer | null = null;
    try {
      view = Reflect.apply(bufferFrom, Buffer, [
        payload.buffer,
        payload.byteOffset,
        payloadBytes,
      ]) as Buffer;
      secret = Reflect.apply(bufferToString, view, ["ascii"]) as string;
      const capturedIntake = intake!;
      const candidate = requireHandoffCandidate(Reflect.apply(
        capturedIntake.method,
        capturedIntake.receiver,
        [secret],
      ));
      if (lifecycle === "committing") lifecycle = "committed";
      return candidate;
    } catch {
      throw sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED");
    } finally {
      secret = null;
      view = null;
      clearMutableState();
    }
  };

  const runRead = async (): Promise<RelayV2HostBootstrapSecretSourceCandidate> => {
    try {
      const candidate = await readAndCommit();
      return requireHandoffCandidate(candidate);
    } catch (caught) {
      let error = caught instanceof RelayV2HostBootstrapSecretSourceError
        ? caught
        : sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED");
      recordFailure(error);
      try {
        await beginCancel();
      } catch (cancelled) {
        error = cancelled instanceof RelayV2HostBootstrapSecretSourceError
          ? cancelled
          : sourceError("RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED");
        recordFailure(error);
      }
      throw error;
    } finally {
      clearMutableState();
      iterator = null;
      source = null;
      intake = null;
    }
  };

  const readCandidate = (): Promise<RelayV2HostBootstrapSecretSourceCandidate> => {
    if (readPromise !== null) return readPromise;
    const read = deferred<RelayV2HostBootstrapSecretSourceCandidate>();
    readPromise = Object.freeze(read.promise);
    observeRejection(readPromise);
    if (lifecycle !== "open") {
      read.reject(closedError());
      return readPromise;
    }
    lifecycle = "reading";
    const drain = deferred<void>();
    readDrainPromise = drain.promise;
    scheduleMicrotask(() => {
      const operation = runRead();
      try {
        void Reflect.apply(promisePrototypeThen, operation, [
          (candidate: RelayV2HostBootstrapSecretSourceCandidate) => {
            try {
              read.resolve(requireHandoffCandidate(candidate));
            } catch {
              const error = sourceError(
                "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_INTAKE_REJECTED",
              );
              recordFailure(error);
              read.reject(error);
            } finally {
              drain.resolve(undefined);
            }
          },
          (error: unknown) => {
            read.reject(error);
            drain.resolve(undefined);
          },
        ]);
      } catch {
        const error = sourceError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_FAILED",
        );
        recordFailure(error);
        read.reject(error);
        drain.resolve(undefined);
      }
    });
    return readPromise;
  };

  const runClose = async (): Promise<void> => {
    try {
      await beginCancel();
    } catch {
      // beginCancel already records the fixed cancellation failure.
    }
    const admittedReadDrain = readDrainPromise;
    if (admittedReadDrain !== null) {
      await admittedReadDrain;
    }
    clearMutableState();
    iterator = null;
    source = null;
    intake = null;
    lifecycle = "closed";
    if (terminalFailure !== null) throw sourceError(terminalFailure);
  };

  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    const close = deferred<void>();
    closePromise = Object.freeze(close.promise);
    observeRejection(closePromise);
    lifecycle = "closing";
    scheduleMicrotask(() => {
      const operation = runClose();
      try {
        void Reflect.apply(promisePrototypeThen, operation, [close.resolve, close.reject]);
      } catch {
        close.reject(sourceError(
          "RELAY_V2_HOST_BOOTSTRAP_SECRET_SOURCE_CANCEL_FAILED",
        ));
      }
    });
    return closePromise;
  };

  return frozenHandle(readCandidate, closeAndDrain);
}
