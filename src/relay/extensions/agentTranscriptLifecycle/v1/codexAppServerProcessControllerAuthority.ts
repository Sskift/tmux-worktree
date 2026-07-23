import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";

import {
  CodexAppServerNotificationSource,
  type CodexAppServerNotificationByteSource,
} from "./codexAppServerNotificationSource.js";
import {
  CODEX_APP_SERVER_V2_PROVIDER,
  CODEX_APP_SERVER_V2_PROVIDER_VERSION,
  CODEX_APP_SERVER_V2_SCHEMA_VERSION,
} from "./codexAppServerProducer.js";
import {
  type CodexControlledSourceLeaseIssuer,
  type CodexControlledSourceEventSink,
  type CodexControlledSourceLease,
  type CodexControlledSourceLeaseDescriptor,
  type CodexControlledSourceReceiver,
  type CodexControlledSourceSubscription,
} from "./codexTrustedSourceComposition.js";

const MAX_ID_UTF8_BYTES = 128;
const MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES = 4_096;

export type CodexAppServerProcessControllerAuthorityState =
  | "disabled"
  | "issuing"
  | "issued"
  | "attached"
  | "closing"
  | "sealed"
  | "closed";

export type CodexAppServerProcessControllerAuthorityErrorCode =
  | "INVALID_CALL"
  | "ISSUE_IN_PROGRESS"
  | "ALREADY_ISSUED"
  | "CONTROLLER_FAILED"
  | "INVALID_CONTROLLER_RESULT"
  | "SOURCE_BINDING_MISMATCH"
  | "SOURCE_CLAIM_FAILED"
  | "LEASE_ISSUE_FAILED"
  | "SOURCE_ATTACH_FAILED"
  | "SOURCE_CLOSE_FAILED"
  | "CLOSING"
  | "SEALED"
  | "CLOSED";

const ERROR_MESSAGES: Readonly<
  Record<CodexAppServerProcessControllerAuthorityErrorCode, string>
> = Object.freeze({
  INVALID_CALL: "Codex controlled-source lease issue does not accept caller authority input",
  ISSUE_IN_PROGRESS: "Codex controlled-source lease issue is already in progress",
  ALREADY_ISSUED: "Codex controlled-source lease was already issued",
  CONTROLLER_FAILED: "Codex process controller failed",
  INVALID_CONTROLLER_RESULT: "Codex process controller result is invalid",
  SOURCE_BINDING_MISMATCH: "Codex controlled process binding is invalid",
  SOURCE_CLAIM_FAILED: "Codex notification byte source could not be claimed",
  LEASE_ISSUE_FAILED: "Codex controlled-source lease could not be issued",
  SOURCE_ATTACH_FAILED: "Codex controlled notification source could not be attached",
  SOURCE_CLOSE_FAILED: "Codex controlled notification source close barrier failed",
  CLOSING: "Codex process controller authority is closing",
  SEALED: "Codex process controller authority is sealed",
  CLOSED: "Codex process controller authority is closed",
});

export class CodexAppServerProcessControllerAuthorityError extends Error {
  constructor(readonly code: CodexAppServerProcessControllerAuthorityErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAppServerProcessControllerAuthorityError";
  }
}

/**
 * Non-sensitive identity already authenticated and selected by the injected
 * controller. This foundation does not derive it from PID, argv, PATH, a
 * handshake, a binary hash, or process output.
 */
export interface CodexAppServerControlledProcessBinding {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  backendInstanceKey: string;
  managedIncarnation: string;
}

export interface CodexAppServerControlledProcess {
  binding: Readonly<CodexAppServerControlledProcessBinding>;
  notificationSource: CodexAppServerNotificationByteSource;
}

/**
 * Injectable future-controller seam. Calling it transfers one exact result;
 * this module never starts, discovers, authenticates, or supervises a process.
 */
export interface CodexAppServerProcessControllerPort {
  claimControlledProcess(): Promise<Readonly<CodexAppServerControlledProcess>>;
}

export interface CodexAppServerProcessControllerAuthorityOptions {
  controller: CodexAppServerProcessControllerPort;
  controlledSourceIssuer: CodexControlledSourceLeaseIssuer;
  controlledSourceReceiver: CodexControlledSourceReceiver;
  onUnavailable?: (error: unknown) => void;
}

interface NormalizedController {
  claimControlledProcess(): unknown;
}

interface NormalizedLeaseIssuer {
  issue(
    receiver: CodexControlledSourceReceiver,
    descriptor: CodexControlledSourceLeaseDescriptor,
  ): unknown;
}

interface CapturedControllerResult {
  binding: unknown;
  notificationSource: unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const claimedControllers = new WeakSet<object>();

function authorityError(
  code: CodexAppServerProcessControllerAuthorityErrorCode,
): CodexAppServerProcessControllerAuthorityError {
  return new CodexAppServerProcessControllerAuthorityError(code);
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

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function exactFrozenDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || !isPlainObject(value)
    || !Object.isFrozen(value)) {
    throw authorityError("INVALID_CONTROLLER_RESULT");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw authorityError("INVALID_CONTROLLER_RESULT");
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || descriptor.configurable
      || descriptor.writable) {
      throw authorityError("INVALID_CONTROLLER_RESULT");
    }
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

function captureControllerResult(value: unknown): Readonly<CapturedControllerResult> {
  const result = exactFrozenDataObject(value, ["binding", "notificationSource"]);
  return Object.freeze({
    binding: result.binding,
    notificationSource: result.notificationSource,
  });
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function opaque(value: unknown, maximumBytes = MAX_ID_UTF8_BYTES): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || !isWellFormedUnicode(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw authorityError("SOURCE_BINDING_MISMATCH");
  }
  return value;
}

function normalizeBinding(
  value: unknown,
): Readonly<CodexAppServerControlledProcessBinding> {
  let binding: Readonly<Record<string, unknown>>;
  try {
    binding = exactFrozenDataObject(value, [
      "hostId",
      "hostEpoch",
      "scopeId",
      "sessionId",
      "backendInstanceKey",
      "managedIncarnation",
    ]);
  } catch {
    throw authorityError("SOURCE_BINDING_MISMATCH");
  }
  return Object.freeze({
    hostId: opaque(binding.hostId),
    hostEpoch: opaque(binding.hostEpoch),
    scopeId: opaque(binding.scopeId),
    sessionId: opaque(binding.sessionId),
    backendInstanceKey: opaque(
      binding.backendInstanceKey,
      MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES,
    ),
    managedIncarnation: opaque(binding.managedIncarnation),
  });
}

function normalizeController(value: unknown): Readonly<NormalizedController> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw new TypeError("Codex process controller authority dependencies are invalid");
  }
  if (claimedControllers.has(value)) {
    throw new TypeError("Codex process controller is already owned");
  }
  const claimControlledProcess = dataMethod(value, "claimControlledProcess");
  if (claimControlledProcess === null) {
    throw new TypeError("Codex process controller authority dependencies are invalid");
  }
  claimedControllers.add(value);
  return Object.freeze({
    claimControlledProcess: () => claimControlledProcess.call(value),
  });
}

function normalizeLeaseIssuer(value: unknown): Readonly<NormalizedLeaseIssuer> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw new TypeError("Codex process controller authority dependencies are invalid");
  }
  const issue = dataMethod(value, "issue");
  if (issue === null) {
    throw new TypeError("Codex process controller authority dependencies are invalid");
  }
  return Object.freeze({
    issue: (
      receiver: CodexControlledSourceReceiver,
      descriptor: CodexControlledSourceLeaseDescriptor,
    ) => issue.call(value, receiver, descriptor),
  });
}

function normalizeLease(value: unknown): CodexControlledSourceLease {
  if (typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== null
    || !Object.isFrozen(value)
    || Reflect.ownKeys(value).length !== 0) {
    throw authorityError("LEASE_ISSUE_FAILED");
  }
  return value as CodexControlledSourceLease;
}

function requireNativePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) throw authorityError("CONTROLLER_FAILED");
  return value as Promise<unknown>;
}

/**
 * Default-off bridge from one injected controller claim to one existing
 * issuer/receiver-bound controlled-source lease. Public issue takes no
 * binding, source, H2 evidence, or authority token from its caller.
 */
export class CodexAppServerProcessControllerAuthority {
  readonly #controller: Readonly<NormalizedController>;
  readonly #controlledSourceIssuer: Readonly<NormalizedLeaseIssuer>;
  readonly #controlledSourceReceiver: CodexControlledSourceReceiver;
  readonly #onUnavailable: ((error: unknown) => void) | null;
  readonly #controllerContext = new AsyncLocalStorage<object>();
  readonly #sourceCloseContext = new AsyncLocalStorage<object>();
  readonly #reentryBarrier = Promise.resolve();

  #state: CodexAppServerProcessControllerAuthorityState = "disabled";
  #failure: CodexAppServerProcessControllerAuthorityErrorCode | null = null;
  #issueBarrier: Deferred<void> | null = null;
  #ownedSource: CodexAppServerNotificationSource | null = null;
  #ownedSourceClosePromise: Promise<void> | null = null;
  #attachAttempted = false;
  #closePromise: Promise<void> | null = null;
  #controllerPhase: object | null = null;
  #sourceClosePhase: object | null = null;
  #fatal = false;

  constructor(options: CodexAppServerProcessControllerAuthorityOptions) {
    if (typeof options !== "object"
      || options === null
      || nodeTypes.isProxy(options)
      || typeof options.controlledSourceIssuer !== "object"
      || options.controlledSourceIssuer === null
      || nodeTypes.isProxy(options.controlledSourceIssuer)
      || typeof options.controlledSourceReceiver !== "object"
      || options.controlledSourceReceiver === null
      || nodeTypes.isProxy(options.controlledSourceReceiver)) {
      throw new TypeError("Codex process controller authority dependencies are invalid");
    }
    this.#controlledSourceIssuer = normalizeLeaseIssuer(options.controlledSourceIssuer);
    this.#controlledSourceReceiver = options.controlledSourceReceiver;
    this.#controller = normalizeController(options.controller);
    if (options.onUnavailable !== undefined
      && (typeof options.onUnavailable !== "function"
        || nodeTypes.isProxy(options.onUnavailable))) {
      throw new TypeError("Codex process controller authority dependencies are invalid");
    }
    this.#onUnavailable = options.onUnavailable ?? null;
  }

  get state(): CodexAppServerProcessControllerAuthorityState {
    return this.#state;
  }

  get failure(): CodexAppServerProcessControllerAuthorityErrorCode | null {
    return this.#failure;
  }

  issueControlledSourceLease(): Promise<CodexControlledSourceLease> {
    if (arguments.length !== 0) {
      return Promise.reject(authorityError("INVALID_CALL"));
    }
    if (this.#state !== "disabled") {
      return Promise.reject(authorityError(
        this.#state === "issuing" ? "ISSUE_IN_PROGRESS"
          : this.#state === "issued" || this.#state === "attached" ? "ALREADY_ISSUED"
            : this.#state === "closing" ? "CLOSING"
              : this.#state === "closed" ? "CLOSED"
                : "SEALED",
      ));
    }
    this.#state = "issuing";
    const barrier = deferred<void>();
    this.#issueBarrier = barrier;
    const issue = this.#runIssue();
    void issue.finally(() => {
      if (this.#issueBarrier === barrier) this.#issueBarrier = null;
      barrier.resolve();
    }).catch(() => undefined);
    return issue;
  }

  close(): Promise<void> {
    const controllerPhase = this.#controllerPhase;
    if (controllerPhase !== null
      && this.#controllerContext.getStore() === controllerPhase) {
      this.#beginClose();
      return this.#reentryBarrier;
    }
    const sourceClosePhase = this.#sourceClosePhase;
    if (sourceClosePhase !== null
      && this.#sourceCloseContext.getStore() === sourceClosePhase) {
      this.#beginClose();
      return this.#reentryBarrier;
    }
    this.#beginClose();
    return this.#closePromise!;
  }

  #beginClose(): void {
    if (this.#closePromise !== null) return;
    if (this.#state !== "sealed" && this.#state !== "closed") this.#state = "closing";
    const completion = deferred<void>();
    this.#closePromise = completion.promise;
    void this.#runClose().then(completion.resolve, completion.reject);
    void completion.promise.catch(() => undefined);
  }

  async #runIssue(): Promise<CodexControlledSourceLease> {
    let controllerResult: unknown;
    const controllerPhase = Object.freeze({});
    this.#controllerPhase = controllerPhase;
    try {
      const claim = this.#controllerContext.run(
        controllerPhase,
        () => this.#controller.claimControlledProcess(),
      );
      controllerResult = await requireNativePromise(claim);
    } catch {
      if (this.#state !== "issuing") throw authorityError("CLOSED");
      await this.#seal("CONTROLLER_FAILED");
      throw authorityError("CONTROLLER_FAILED");
    } finally {
      if (this.#controllerPhase === controllerPhase) this.#controllerPhase = null;
    }

    let captured: Readonly<CapturedControllerResult>;
    try {
      captured = captureControllerResult(controllerResult);
    } catch {
      if (this.#state !== "issuing") throw authorityError("CLOSED");
      await this.#seal("INVALID_CONTROLLER_RESULT");
      throw authorityError("INVALID_CONTROLLER_RESULT");
    }

    let source: CodexAppServerNotificationSource;
    try {
      source = new CodexAppServerNotificationSource(
        captured.notificationSource as CodexAppServerNotificationByteSource,
        this.#onUnavailable,
      );
      this.#ownedSource = source;
    } catch {
      if (this.#state !== "issuing") throw authorityError("CLOSED");
      await this.#seal("SOURCE_CLAIM_FAILED");
      throw authorityError("SOURCE_CLAIM_FAILED");
    }

    if (this.#state !== "issuing") {
      await this.#closeOwnedSourceIgnoringFailure();
      throw authorityError("CLOSED");
    }

    let binding: Readonly<CodexAppServerControlledProcessBinding>;
    try {
      binding = normalizeBinding(captured.binding);
    } catch {
      await this.#seal("SOURCE_BINDING_MISMATCH");
      throw authorityError("SOURCE_BINDING_MISMATCH");
    }

    const descriptor: CodexControlledSourceLeaseDescriptor = Object.freeze({
      ...binding,
      provider: CODEX_APP_SERVER_V2_PROVIDER,
      providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION,
      schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
      attach: (eventSink: CodexControlledSourceEventSink): CodexControlledSourceSubscription => (
        this.#attachOwnedSource(source, eventSink)
      ),
    });

    let lease: CodexControlledSourceLease;
    try {
      lease = normalizeLease(this.#controlledSourceIssuer.issue(
        this.#controlledSourceReceiver,
        descriptor,
      ));
    } catch {
      await this.#seal("LEASE_ISSUE_FAILED");
      throw authorityError("LEASE_ISSUE_FAILED");
    }
    if (this.#state !== "issuing") {
      await this.#closeOwnedSourceIgnoringFailure();
      throw authorityError("CLOSED");
    }
    this.#state = "issued";
    return lease;
  }

  #attachOwnedSource(
    source: CodexAppServerNotificationSource,
    eventSink: CodexControlledSourceEventSink,
  ): CodexControlledSourceSubscription {
    if (this.#state !== "issued"
      || this.#ownedSource !== source
      || this.#attachAttempted) {
      throw authorityError(
        this.#state === "closing" ? "CLOSING"
          : this.#state === "closed" ? "CLOSED"
            : this.#state === "sealed" ? "SEALED"
              : "SOURCE_ATTACH_FAILED",
      );
    }
    this.#attachAttempted = true;
    try {
      const subscription = source.attach(eventSink);
      const stateAfterAttach = this.#observedState();
      if (stateAfterAttach !== "issued" || this.#ownedSource !== source) {
        throw authorityError(stateAfterAttach === "closing" ? "CLOSING" : "CLOSED");
      }
      this.#ownedSource = null;
      this.#state = "attached";
      return subscription;
    } catch {
      const failedState = this.#observedState();
      if (failedState !== "closing" && failedState !== "closed") {
        this.#fatal = true;
        this.#failure ??= "SOURCE_ATTACH_FAILED";
        this.#state = "sealed";
      }
      void this.#closeOwnedSourceIgnoringFailure();
      throw authorityError("SOURCE_ATTACH_FAILED");
    }
  }

  #observedState(): CodexAppServerProcessControllerAuthorityState {
    return this.#state;
  }

  async #seal(code: CodexAppServerProcessControllerAuthorityErrorCode): Promise<void> {
    this.#fatal = true;
    this.#failure ??= code;
    this.#state = "sealed";
    await this.#closeOwnedSourceIgnoringFailure();
  }

  async #runClose(): Promise<void> {
    const issueBarrier = this.#issueBarrier;
    if (issueBarrier !== null) await issueBarrier.promise;
    let closeFailed = false;
    try {
      await this.#closeOwnedSource();
    } catch {
      closeFailed = true;
      this.#fatal = true;
      this.#failure ??= "SOURCE_CLOSE_FAILED";
    }
    this.#state = this.#fatal ? "sealed" : "closed";
    if (closeFailed) throw authorityError("SOURCE_CLOSE_FAILED");
  }

  async #closeOwnedSourceIgnoringFailure(): Promise<void> {
    try {
      await this.#closeOwnedSource();
    } catch {
      this.#fatal = true;
      this.#failure ??= "SOURCE_CLOSE_FAILED";
      this.#state = "sealed";
    }
  }

  #closeOwnedSource(): Promise<void> {
    if (this.#ownedSourceClosePromise !== null) return this.#ownedSourceClosePromise;
    const source = this.#ownedSource;
    if (source === null) return Promise.resolve();
    this.#ownedSourceClosePromise = (async () => {
      const sourceClosePhase = Object.freeze({});
      this.#sourceClosePhase = sourceClosePhase;
      try {
        const barrier = this.#sourceCloseContext.run(
          sourceClosePhase,
          () => source.closeAndDrain(),
        );
        if (!nodeTypes.isPromise(barrier)) throw authorityError("SOURCE_CLOSE_FAILED");
        await barrier;
      } finally {
        if (this.#sourceClosePhase === sourceClosePhase) this.#sourceClosePhase = null;
        if (this.#ownedSource === source) this.#ownedSource = null;
      }
    })();
    void this.#ownedSourceClosePromise.catch(() => undefined);
    return this.#ownedSourceClosePromise;
  }
}
