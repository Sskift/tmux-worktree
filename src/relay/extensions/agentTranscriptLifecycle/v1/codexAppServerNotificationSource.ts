import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";

import {
  CODEX_TRUSTED_SOURCE_PRODUCER_LIMITS,
  type CodexControlledSourceEventSink,
  type CodexControlledSourceSubscription,
} from "./codexTrustedSourceComposition.js";

export const CODEX_APP_SERVER_NOTIFICATION_SOURCE_LIMITS = Object.freeze({
  maxFrameBytes: CODEX_TRUSTED_SOURCE_PRODUCER_LIMITS.maxInputBytes,
  maxChunkBytes: CODEX_TRUSTED_SOURCE_PRODUCER_LIMITS.maxInputBytes + 1,
});

export type CodexAppServerNotificationSourceState =
  | "detached"
  | "attached"
  | "closing"
  | "sealed"
  | "closed";

export type CodexAppServerNotificationSourceErrorCode =
  | "INVALID_SOURCE"
  | "SOURCE_ALREADY_OWNED"
  | "INVALID_SINK"
  | "ALREADY_ATTACHED"
  | "INVALID_CHUNK"
  | "EMPTY_FRAME"
  | "FRAME_TOO_LARGE"
  | "PARTIAL_EOF"
  | "SOURCE_FAILED"
  | "SINK_REJECTED"
  | "STOP_FAILED"
  | "CLOSING"
  | "SEALED"
  | "CLOSED";

const ERROR_MESSAGES: Readonly<Record<CodexAppServerNotificationSourceErrorCode, string>> =
  Object.freeze({
    INVALID_SOURCE: "Codex notification byte source is invalid",
    SOURCE_ALREADY_OWNED: "Codex notification byte source is already owned",
    INVALID_SINK: "Codex notification sink is invalid",
    ALREADY_ATTACHED: "Codex notification source was already attached",
    INVALID_CHUNK: "Codex notification byte source produced an invalid chunk",
    EMPTY_FRAME: "Codex notification byte source produced an empty frame",
    FRAME_TOO_LARGE: "Codex notification frame exceeded the bounded limit",
    PARTIAL_EOF: "Codex notification byte source ended with a partial frame",
    SOURCE_FAILED: "Codex notification byte source failed",
    SINK_REJECTED: "Codex notification sink rejected an admitted frame",
    STOP_FAILED: "Codex notification byte source stop failed",
    CLOSING: "Codex notification source is closing",
    SEALED: "Codex notification source is sealed",
    CLOSED: "Codex notification source is closed",
  });

export class CodexAppServerNotificationSourceError extends Error {
  constructor(readonly code: CodexAppServerNotificationSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAppServerNotificationSourceError";
  }
}

/**
 * A byte channel already owned and authenticated by a future controller.
 * This boundary only consumes bytes and requests cancellation; it neither
 * starts nor authenticates the process that produced them.
 */
export interface CodexAppServerNotificationByteSource extends AsyncIterable<Uint8Array> {
  cancel(): void | Promise<void>;
}

interface NormalizedByteSource {
  openIterator(): unknown;
  cancel(): unknown;
}

interface NormalizedIterator {
  next(): unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const claimedByteSources = new WeakSet<object>();
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  "byteLength",
)!.get!;
const copyUint8Array = Uint8Array.prototype.set;

function sourceError(
  code: CodexAppServerNotificationSourceErrorCode,
): CodexAppServerNotificationSourceError {
  return new CodexAppServerNotificationSourceError(code);
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

function dataMethod(value: object, key: PropertyKey): Function | null {
  let owner: object | null = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)
        || typeof descriptor.value !== "function"
        || nodeTypes.isProxy(descriptor.value)) {
        return null;
      }
      return descriptor.value;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function normalizeByteSource(value: unknown): Readonly<NormalizedByteSource> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw sourceError("INVALID_SOURCE");
  }
  if (claimedByteSources.has(value)) throw sourceError("SOURCE_ALREADY_OWNED");
  const openIterator = dataMethod(value, Symbol.asyncIterator);
  const cancel = dataMethod(value, "cancel");
  if (openIterator === null || cancel === null) throw sourceError("INVALID_SOURCE");
  claimedByteSources.add(value);
  return Object.freeze({
    openIterator: () => openIterator.call(value),
    cancel: () => cancel.call(value),
  });
}

function normalizeIterator(value: unknown): Readonly<NormalizedIterator> {
  if ((typeof value !== "object" && typeof value !== "function")
    || value === null
    || nodeTypes.isProxy(value)) {
    throw sourceError("SOURCE_FAILED");
  }
  const next = dataMethod(value, "next");
  if (next === null) throw sourceError("SOURCE_FAILED");
  return Object.freeze({ next: () => next.call(value) });
}

function normalizeIteratorResult(value: unknown): IteratorResult<Uint8Array> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw sourceError("SOURCE_FAILED");
  }
  const done = (value as { done?: unknown }).done;
  if (typeof done !== "boolean") throw sourceError("SOURCE_FAILED");
  if (done) return { done: true, value: undefined };
  return { done: false, value: (value as { value?: unknown }).value as Uint8Array };
}

function requireNativePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) throw sourceError("SOURCE_FAILED");
  return value as Promise<unknown>;
}

function normalizeChunk(value: unknown): Uint8Array | null {
  if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value)) return null;
  const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
  if (byteLength === 0
    || byteLength > CODEX_APP_SERVER_NOTIFICATION_SOURCE_LIMITS.maxChunkBytes) {
    return null;
  }
  const chunk = new Uint8Array(byteLength);
  Reflect.apply(copyUint8Array, chunk, [value]);
  return chunk;
}

/**
 * Default-off LF-framed source for one controller-supplied byte channel.
 * It owns only bounded framing, callback admission, serial delivery, source
 * cancellation, and the close barrier.
 */
export class CodexAppServerNotificationSource {
  readonly #source: Readonly<NormalizedByteSource>;
  readonly #frameBuffer = new Uint8Array(
    CODEX_APP_SERVER_NOTIFICATION_SOURCE_LIMITS.maxFrameBytes,
  );
  readonly #callbackContext = new AsyncLocalStorage<object>();
  readonly #stopContext = new AsyncLocalStorage<object>();
  readonly #reentryBarrier = Promise.resolve();

  #state: CodexAppServerNotificationSourceState = "detached";
  #failure: CodexAppServerNotificationSourceErrorCode | null = null;
  #admitting = false;
  #bufferedBytes = 0;
  #sink: CodexControlledSourceEventSink | null = null;
  #iterator: Readonly<NormalizedIterator> | null = null;
  #pumpPromise: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #closeDeferred: Deferred<void> | null = null;
  #callbackPhase: object | null = null;
  #stopPhase: object | null = null;

  constructor(byteSource: CodexAppServerNotificationByteSource) {
    this.#source = normalizeByteSource(byteSource);
  }

  get state(): CodexAppServerNotificationSourceState {
    return this.#state;
  }

  get failure(): CodexAppServerNotificationSourceErrorCode | null {
    return this.#failure;
  }

  attach(eventSink: CodexControlledSourceEventSink): CodexControlledSourceSubscription {
    if (this.#state !== "detached") {
      const code = this.#state === "attached" ? "ALREADY_ATTACHED"
        : this.#state === "closing" ? "CLOSING"
          : this.#state === "closed" ? "CLOSED"
            : "SEALED";
      if (this.#state === "attached") this.#fail("ALREADY_ATTACHED");
      throw sourceError(code);
    }
    if (typeof eventSink !== "function" || nodeTypes.isProxy(eventSink)) {
      this.#fail("INVALID_SINK");
      throw sourceError("INVALID_SINK");
    }

    this.#state = "attached";
    this.#admitting = true;
    this.#sink = eventSink;
    try {
      const iterator = normalizeIterator(this.#source.openIterator());
      if (this.#state !== "attached" || !this.#admitting) {
        throw sourceError(this.#state === "sealed" ? "SEALED" : "CLOSING");
      }
      this.#iterator = iterator;
    } catch {
      if (this.#state === "attached") {
        this.#fail("SOURCE_FAILED");
        throw sourceError("SOURCE_FAILED");
      }
      throw sourceError(this.#state === "sealed" ? "SEALED"
        : this.#state === "closed" ? "CLOSED"
          : "CLOSING");
    }

    const subscription = Object.freeze({
      closeAndDrain: (): Promise<void> => this.closeAndDrain(),
    });
    const pump = deferred<void>();
    this.#pumpPromise = pump.promise;
    queueMicrotask(() => {
      void this.#pump().then(pump.resolve, pump.reject);
    });
    void pump.promise.catch(() => undefined);
    return subscription;
  }

  closeAndDrain(): Promise<void> {
    const callbackPhase = this.#callbackPhase;
    if (callbackPhase !== null && this.#callbackContext.getStore() === callbackPhase) {
      this.#beginClose();
      return this.#reentryBarrier;
    }
    const stopPhase = this.#stopPhase;
    if (stopPhase !== null && this.#stopContext.getStore() === stopPhase) {
      this.#beginClose();
      return this.#reentryBarrier;
    }
    this.#beginClose();
    return this.#closeDeferred!.promise;
  }

  async #pump(): Promise<void> {
    try {
      while (this.#admitting) {
        let item: IteratorResult<Uint8Array>;
        try {
          const next = this.#iterator!.next();
          item = normalizeIteratorResult(await requireNativePromise(next));
        } catch {
          if (this.#admitting) this.#fail("SOURCE_FAILED");
          return;
        }
        if (!this.#admitting) return;
        if (item.done) {
          if (this.#bufferedBytes !== 0) this.#fail("PARTIAL_EOF");
          else this.#beginClose();
          return;
        }
        const chunk = normalizeChunk(item.value);
        if (chunk === null) {
          this.#fail("INVALID_CHUNK");
          return;
        }
        if (!await this.#consumeChunk(chunk)) return;
      }
    } catch {
      this.#fail("SOURCE_FAILED");
    }
  }

  async #consumeChunk(chunk: Uint8Array): Promise<boolean> {
    let offset = 0;
    while (offset < chunk.byteLength && this.#admitting) {
      const lineFeed = chunk.indexOf(0x0a, offset);
      const end = lineFeed === -1 ? chunk.byteLength : lineFeed;
      const fragmentBytes = end - offset;
      if (fragmentBytes > this.#frameBuffer.byteLength - this.#bufferedBytes) {
        this.#fail("FRAME_TOO_LARGE");
        return false;
      }
      this.#frameBuffer.set(chunk.subarray(offset, end), this.#bufferedBytes);
      this.#bufferedBytes += fragmentBytes;
      if (lineFeed === -1) return true;
      if (this.#bufferedBytes === 0) {
        this.#fail("EMPTY_FRAME");
        return false;
      }

      const frame = this.#frameBuffer.slice(0, this.#bufferedBytes);
      this.#bufferedBytes = 0;
      if (!await this.#deliverFrame(frame)) return false;
      offset = lineFeed + 1;
    }
    return this.#admitting;
  }

  async #deliverFrame(frame: Uint8Array): Promise<boolean> {
    if (!this.#admitting || this.#sink === null) return false;
    const callbackPhase = Object.freeze({});
    this.#callbackPhase = callbackPhase;
    let accepted: unknown;
    try {
      accepted = this.#callbackContext.run(
        callbackPhase,
        () => this.#sink!(new Uint8Array(frame)),
      );
      if (!nodeTypes.isPromise(accepted)) throw sourceError("SINK_REJECTED");
      await accepted;
    } catch {
      this.#fail("SINK_REJECTED");
      return false;
    } finally {
      if (this.#callbackPhase === callbackPhase) this.#callbackPhase = null;
    }
    return this.#admitting;
  }

  #fail(code: CodexAppServerNotificationSourceErrorCode): void {
    this.#failure ??= code;
    this.#state = "sealed";
    this.#admitting = false;
    this.#beginClose();
  }

  #beginClose(): void {
    this.#admitting = false;
    if (this.#state !== "sealed" && this.#state !== "closed") this.#state = "closing";
    if (this.#closeDeferred !== null) return;
    this.#closeDeferred = deferred<void>();
    void this.#runClose().then(this.#closeDeferred.resolve, this.#closeDeferred.reject);
    void this.#closeDeferred.promise.catch(() => undefined);
  }

  async #runClose(): Promise<void> {
    const stop = this.#stopSource();
    const pump = this.#pumpPromise ?? Promise.resolve();
    const [stopResult, pumpResult] = await Promise.allSettled([stop, pump]);
    if (stopResult.status === "rejected") this.#failure ??= "STOP_FAILED";
    if (pumpResult.status === "rejected") this.#failure ??= "SOURCE_FAILED";
    this.#sink = null;
    this.#iterator = null;
    this.#bufferedBytes = 0;
    if (this.#failure !== null) {
      this.#state = "sealed";
      throw sourceError(this.#failure);
    }
    this.#state = "closed";
  }

  #stopSource(): Promise<void> {
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopPromise = (async () => {
      const stopPhase = Object.freeze({});
      this.#stopPhase = stopPhase;
      try {
        const result = this.#stopContext.run(stopPhase, () => this.#source.cancel());
        if (result === undefined) return;
        if (!nodeTypes.isPromise(result)) throw sourceError("STOP_FAILED");
        await result;
      } finally {
        if (this.#stopPhase === stopPhase) this.#stopPhase = null;
      }
    })();
    return this.#stopPromise;
  }
}
