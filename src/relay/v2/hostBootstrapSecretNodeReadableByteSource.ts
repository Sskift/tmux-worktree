import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2HostBootstrapSecretByteSource,
} from "./hostBootstrapSecretSource.js";

const CANCEL_DEADLINE_MS = 1_000;
const claimedReadables = new WeakSet<object>();
const nativeReadableDestroy = Readable.prototype.destroy;
const nativeEventOn = EventEmitter.prototype.on;
const nativeEventRemoveListener = EventEmitter.prototype.removeListener;
const readableClosedGetter = Object.getOwnPropertyDescriptor(
  Readable.prototype,
  "closed",
)?.get;

export type RelayV2HostBootstrapSecretNodeReadableByteSourceErrorCode =
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_INVALID"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_ALREADY_CLAIMED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_FAILED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_CANCEL_FAILED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostBootstrapSecretNodeReadableByteSourceErrorCode,
string
>> = Object.freeze({
  RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_INVALID:
    "Relay v2 host bootstrap secret Node Readable is invalid",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_ALREADY_CLAIMED:
    "Relay v2 host bootstrap secret Node Readable is already claimed",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_FAILED:
    "Relay v2 host bootstrap secret Node Readable failed",
  RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_CANCEL_FAILED:
    "Relay v2 host bootstrap secret Node Readable cancellation failed",
});

export class RelayV2HostBootstrapSecretNodeReadableByteSourceError extends Error {
  constructor(
    readonly code: RelayV2HostBootstrapSecretNodeReadableByteSourceErrorCode,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostBootstrapSecretNodeReadableByteSourceError";
  }
}

interface CapturedReadable {
  readonly receiver: Readable;
  readonly openIterator: Function;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

interface InitialOwnerState {
  readable: Readable | null;
  iteratorMethod: Function | null;
}

function failure(
  code: RelayV2HostBootstrapSecretNodeReadableByteSourceErrorCode,
): RelayV2HostBootstrapSecretNodeReadableByteSourceError {
  return new RelayV2HostBootstrapSecretNodeReadableByteSourceError(code);
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function captureDataMethod(value: object, key: PropertyKey): Function | null {
  let owner: object | null = value;
  try {
    while (owner !== null) {
      if (rejectedProxy(owner)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, "value")
          && typeof descriptor.value === "function"
          && !rejectedProxy(descriptor.value)
          ? descriptor.value
          : null;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function captureReadable(value: unknown): CapturedReadable {
  if (value === null
    || typeof value !== "object"
    || rejectedProxy(value)
    || !(value instanceof Readable)) {
    throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_INVALID");
  }
  if (claimedReadables.has(value)) {
    throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_ALREADY_CLAIMED");
  }
  const openIterator = captureDataMethod(value, Symbol.asyncIterator);
  const destroy = captureDataMethod(value, "destroy");
  if (openIterator === null || destroy !== nativeReadableDestroy) {
    throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_INVALID");
  }
  return Object.freeze({ receiver: value, openIterator });
}

function captureIterator(value: unknown): object {
  if ((typeof value !== "object" && typeof value !== "function")
    || value === null
    || rejectedProxy(value)
    || captureDataMethod(value as object, "next") === null) {
    throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_FAILED");
  }
  return value as object;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return Object.freeze({ promise, resolve, reject });
}

function isClosed(readable: Readable): boolean {
  if (readableClosedGetter === undefined) return false;
  try {
    return Reflect.apply(readableClosedGetter, readable, []) === true;
  } catch {
    return false;
  }
}

const ignoreLateDestroyError = (): void => {};

function createOwnedByteSource(
  initial: InitialOwnerState,
): RelayV2HostBootstrapSecretByteSource {
  let readable = initial.readable;
  let iteratorMethod = initial.iteratorMethod;
  initial.readable = null;
  initial.iteratorMethod = null;
  let iterator: object | null = null;
  let iteratorIssued = false;
  let cancelPromise: Promise<void> | null = null;
  let byteSource!: RelayV2HostBootstrapSecretByteSource;

  const openIterator = function openIterator(this: unknown): AsyncIterator<Uint8Array> {
    if (this !== byteSource
      || iteratorIssued
      || readable === null
      || iteratorMethod === null) {
      throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_FAILED");
    }
    iteratorIssued = true;
    let opened: unknown;
    try {
      opened = Reflect.apply(iteratorMethod, readable, []);
      iterator = captureIterator(opened);
    } catch {
      throw failure("RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_FAILED");
    }
    return iterator as AsyncIterator<Uint8Array>;
  };

  const cancel = function cancel(this: unknown): Promise<void> {
    if (this !== byteSource) {
      const rejected = Promise.reject<void>(failure(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_CANCEL_FAILED",
      ));
      void rejected.catch(() => undefined);
      return rejected;
    }
    if (cancelPromise !== null) return cancelPromise;

    const cancellation = deferred();
    cancelPromise = Object.freeze(cancellation.promise);
    const current = readable;
    readable = null;
    iteratorMethod = null;
    iterator = null;
    if (current === null) {
      cancellation.resolve();
      return cancelPromise;
    }

    let settled = false;
    let timer: ReturnType<typeof nodeSetTimeout> | null = null;
    const remove = (event: "error" | "close", listener: Function): void => {
      try {
        Reflect.apply(nativeEventRemoveListener, current, [event, listener]);
      } catch {}
    };
    const retainLateErrorGuard = (): void => {
      try {
        Reflect.apply(nativeEventOn, current, ["error", ignoreLateDestroyError]);
      } catch {}
    };
    const finish = (outcome: "closed" | "failed"): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) nodeClearTimeout(timer);
      remove("error", onError);
      remove("close", onClose);
      if (outcome === "failed") retainLateErrorGuard();
      if (outcome === "closed") cancellation.resolve();
      else cancellation.reject(failure(
        "RELAY_V2_HOST_BOOTSTRAP_SECRET_NODE_READABLE_CANCEL_FAILED",
      ));
    };
    const onError = (): void => finish("failed");
    const onClose = (): void => finish("closed");

    try {
      Reflect.apply(nativeEventOn, current, ["error", onError]);
      Reflect.apply(nativeEventOn, current, ["close", onClose]);
      timer = nodeSetTimeout(() => finish("failed"), CANCEL_DEADLINE_MS);
      Reflect.apply(nativeReadableDestroy, current, []);
      if (isClosed(current)) finish("closed");
    } catch {
      finish("failed");
    }
    return cancelPromise;
  };

  const result = Object.create(null) as RelayV2HostBootstrapSecretByteSource;
  Object.defineProperties(result, {
    [Symbol.asyncIterator]: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: openIterator,
    },
    cancel: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: cancel,
    },
  });
  byteSource = Object.freeze(result);
  return byteSource;
}

/**
 * Inert, single-owner bridge from one injected Node Readable to the existing
 * H-Cred2 byte-source owner. It never selects process.stdin, decodes chunks,
 * or owns record/token validation.
 */
export function createRelayV2HostBootstrapSecretNodeReadableByteSource(
  input: Readable,
): RelayV2HostBootstrapSecretByteSource {
  const captured = captureReadable(input);
  claimedReadables.add(captured.receiver);
  return createOwnedByteSource({
    readable: captured.receiver,
    iteratorMethod: captured.openIterator,
  });
}
