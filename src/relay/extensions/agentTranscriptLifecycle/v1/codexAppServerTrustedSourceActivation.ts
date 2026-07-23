import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";

import type { RelayV2CanonicalResourceResolverPort } from "../../../v2/resourceState.js";
import {
  CodexAppServerProcessControllerAuthority,
  type CodexAppServerProcessControllerPort,
} from "./codexAppServerProcessControllerAuthority.js";
import {
  CodexControlledSourceLeaseIssuer,
  CodexTrustedSourceComposition,
  type CodexControlledSourceLease,
} from "./codexTrustedSourceComposition.js";
import type { RelayAgentTranscriptLifecycleRuntime } from "./runtime.js";

export type CodexAppServerTrustedSourceActivationErrorCode =
  | "INVALID_CALL"
  | "ACTIVATION_IN_PROGRESS"
  | "ALREADY_ACTIVATED"
  | "ACTIVATION_FAILED"
  | "CLOSING"
  | "SEALED"
  | "CLOSED"
  | "CLEANUP_FAILED";

const ERROR_MESSAGES: Readonly<Record<
  CodexAppServerTrustedSourceActivationErrorCode,
  string
>> = Object.freeze({
  INVALID_CALL: "Codex app-server trusted-source activation accepts no caller authority input",
  ACTIVATION_IN_PROGRESS: "Codex app-server trusted-source activation is already in progress",
  ALREADY_ACTIVATED: "Codex app-server trusted source was already activated",
  ACTIVATION_FAILED: "Codex app-server trusted-source activation failed",
  CLOSING: "Codex app-server trusted-source activation is closing",
  SEALED: "Codex app-server trusted-source activation is sealed",
  CLOSED: "Codex app-server trusted-source activation is closed",
  CLEANUP_FAILED: "Codex app-server trusted-source activation cleanup failed",
});

export class CodexAppServerTrustedSourceActivationError extends Error {
  constructor(readonly code: CodexAppServerTrustedSourceActivationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAppServerTrustedSourceActivationError";
  }
}

export interface CodexAppServerTrustedSourceActivationOptions {
  controller: CodexAppServerProcessControllerPort;
  runtime: RelayAgentTranscriptLifecycleRuntime;
  canonicalResourceResolver: RelayV2CanonicalResourceResolverPort;
  onUnavailable?: (error: unknown) => void;
}

type ActivationState =
  | "disabled"
  | "activating"
  | "enabled"
  | "closing"
  | "sealed"
  | "closed";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface CapturedOptions {
  controller: unknown;
  runtime: unknown;
  canonicalResourceResolver: unknown;
  onUnavailable: ((error: unknown) => void) | null;
}

const REQUIRED_OPTION_KEYS = Object.freeze([
  "controller",
  "runtime",
  "canonicalResourceResolver",
]);
const OPTION_KEYS = Object.freeze([...REQUIRED_OPTION_KEYS, "onUnavailable"]);

function activationError(
  code: CodexAppServerTrustedSourceActivationErrorCode,
): CodexAppServerTrustedSourceActivationError {
  return new CodexAppServerTrustedSourceActivationError(code);
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

function captureOptions(value: unknown): Readonly<CapturedOptions> {
  if (typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)) {
    throw new TypeError("Codex app-server trusted-source activation dependencies are invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Codex app-server trusted-source activation dependencies are invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if ((keys.length !== REQUIRED_OPTION_KEYS.length && keys.length !== OPTION_KEYS.length)
    || keys.some((key) => typeof key !== "string" || !OPTION_KEYS.includes(key))
    || REQUIRED_OPTION_KEYS.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new TypeError("Codex app-server trusted-source activation dependencies are invalid");
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Codex app-server trusted-source activation dependencies are invalid");
    }
    captured[key] = descriptor.value;
  }
  if (captured.onUnavailable !== undefined
    && (typeof captured.onUnavailable !== "function"
      || nodeTypes.isProxy(captured.onUnavailable))) {
    throw new TypeError("Codex app-server trusted-source activation dependencies are invalid");
  }
  return Object.freeze({
    controller: captured.controller,
    runtime: captured.runtime,
    canonicalResourceResolver: captured.canonicalResourceResolver,
    onUnavailable: (captured.onUnavailable ?? null) as ((error: unknown) => void) | null,
  });
}

function requireNativePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) return Promise.reject(activationError("CLEANUP_FAILED"));
  return value as Promise<unknown>;
}

/**
 * Default-off, one-shot composition owner for the already injectable Codex
 * process-controller authority and trusted-source composition. It neither
 * starts nor authenticates an app-server process and it does not manufacture
 * H2 evidence, process continuity, or capability readiness.
 */
export class CodexAppServerTrustedSourceActivation {
  readonly #authority: CodexAppServerProcessControllerAuthority;
  readonly #composition: CodexTrustedSourceComposition;
  readonly #callbackContext = new AsyncLocalStorage<object>();
  readonly #cleanupContext = new AsyncLocalStorage<object>();
  readonly #callbackReentryBarrier = Promise.resolve();
  readonly #cleanupReentryBarrier = Promise.resolve();

  #state: ActivationState = "disabled";
  #activationAttempt: object | null = null;
  #activationSettled: Deferred<void> | null = null;
  #callbackPhase: object | null = null;
  #cleanupPhase: object | null = null;
  #closePromise: Promise<void> | null = null;
  #fatal = false;

  constructor(optionsInput: CodexAppServerTrustedSourceActivationOptions) {
    const options = captureOptions(optionsInput);
    const issuer = new CodexControlledSourceLeaseIssuer();
    const receiver = issuer.createReceiver();
    const composition = new CodexTrustedSourceComposition({
      runtime: options.runtime as RelayAgentTranscriptLifecycleRuntime,
      canonicalResourceResolver: options.canonicalResourceResolver as
        RelayV2CanonicalResourceResolverPort,
      controlledSourceIssuer: issuer,
      controlledSourceReceiver: receiver,
    });
    const authority = new CodexAppServerProcessControllerAuthority({
      controller: options.controller as CodexAppServerProcessControllerPort,
      controlledSourceIssuer: issuer,
      controlledSourceReceiver: receiver,
      ...(options.onUnavailable === null ? {} : { onUnavailable: options.onUnavailable }),
    });
    this.#composition = composition;
    this.#authority = authority;
  }

  activate(): Promise<void> {
    if (arguments.length !== 0) return Promise.reject(activationError("INVALID_CALL"));
    if (this.#state !== "disabled") {
      return Promise.reject(activationError(
        this.#state === "activating" ? "ACTIVATION_IN_PROGRESS"
          : this.#state === "enabled" ? "ALREADY_ACTIVATED"
            : this.#state === "closing" ? "CLOSING"
              : this.#state === "closed" ? "CLOSED"
                : "SEALED",
      ));
    }

    const attempt = Object.freeze({});
    const callbackPhase = Object.freeze({});
    const settled = deferred<void>();
    this.#state = "activating";
    this.#activationAttempt = attempt;
    this.#activationSettled = settled;
    this.#callbackPhase = callbackPhase;

    const work = this.#callbackContext.run(
      callbackPhase,
      () => this.#runActivation(attempt),
    );
    void work.then(settled.resolve, () => settled.resolve());

    const result = work.catch(async (error: unknown) => {
      this.#beginClose();
      try {
        await this.#closePromise!;
      } catch {
        // The fixed activation failure remains primary. External close exposes
        // a separate fixed cleanup failure and never retries either owner.
      }
      throw error;
    });
    void result.catch(() => undefined);
    return result;
  }

  close(): Promise<void> {
    const callbackPhase = this.#callbackPhase;
    if (callbackPhase !== null
      && this.#callbackContext.getStore() === callbackPhase) {
      this.#beginClose();
      return this.#callbackReentryBarrier;
    }
    const cleanupPhase = this.#cleanupPhase;
    if (cleanupPhase !== null
      && this.#cleanupContext.getStore() === cleanupPhase) {
      this.#beginClose();
      return this.#cleanupReentryBarrier;
    }
    this.#beginClose();
    return this.#closePromise!;
  }

  async #runActivation(attempt: object): Promise<void> {
    let lease: CodexControlledSourceLease;
    try {
      lease = await this.#authority.issueControlledSourceLease();
      this.#assertActivationAttempt(attempt);
      await this.#composition.enable(lease);
      this.#assertActivationAttempt(attempt);
      this.#activationAttempt = null;
      this.#state = "enabled";
    } catch {
      if (this.#state === "closing" || this.#state === "closed") {
        this.#activationAttempt = null;
        throw activationError("CLOSED");
      }
      this.#fatal = true;
      this.#activationAttempt = null;
      this.#state = "sealed";
      this.#beginClose();
      throw activationError("ACTIVATION_FAILED");
    }
  }

  #assertActivationAttempt(attempt: object): void {
    if (this.#state !== "activating" || this.#activationAttempt !== attempt) {
      throw activationError(
        this.#state === "closing" || this.#state === "closed" ? "CLOSED" : "SEALED",
      );
    }
  }

  #beginClose(): void {
    if (this.#closePromise !== null) return;
    if (this.#state !== "sealed" && this.#state !== "closed") this.#state = "closing";
    this.#activationAttempt = null;
    const completion = deferred<void>();
    this.#closePromise = completion.promise;
    void this.#runClose().then(completion.resolve, completion.reject);
    void completion.promise.catch(() => undefined);
  }

  async #runClose(): Promise<void> {
    const cleanupPhase = Object.freeze({});
    this.#cleanupPhase = cleanupPhase;
    const initial = this.#cleanupContext.run(cleanupPhase, () => [
      this.#closeComposition(),
      this.#closeAuthority(),
    ]);
    for (const barrier of initial) void barrier.catch(() => undefined);

    const activationSettled = this.#activationSettled;
    if (activationSettled !== null) await activationSettled.promise;

    const final = this.#cleanupContext.run(cleanupPhase, () => [
      this.#closeComposition(),
      this.#closeAuthority(),
    ]);
    const results = await Promise.allSettled([...initial, ...final]);
    const failed = results.some((result) => result.status === "rejected");
    const innerSealed = this.#composition.state === "sealed"
      || this.#authority.state === "sealed";
    this.#callbackPhase = null;
    this.#cleanupPhase = null;
    if (failed || innerSealed) this.#fatal = true;
    this.#state = this.#fatal ? "sealed" : "closed";
    if (failed) throw activationError("CLEANUP_FAILED");
  }

  #closeComposition(): Promise<unknown> {
    try {
      return requireNativePromise(this.#composition.close());
    } catch {
      return Promise.reject(activationError("CLEANUP_FAILED"));
    }
  }

  #closeAuthority(): Promise<unknown> {
    try {
      return requireNativePromise(this.#authority.close());
    } catch {
      return Promise.reject(activationError("CLEANUP_FAILED"));
    }
  }
}
