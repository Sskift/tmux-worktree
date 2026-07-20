import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { types as nodeTypes } from "node:util";

import type {
  RelayV2CanonicalResolvedSessionTarget,
  RelayV2CanonicalResourceResolverPort,
  RelayV2CanonicalResourceResolverToken,
} from "../../../v2/resourceState.js";
import {
  CODEX_APP_SERVER_V2_PROVIDER,
  CODEX_APP_SERVER_V2_PROVIDER_VERSION,
  CODEX_APP_SERVER_V2_SCHEMA_VERSION,
  CodexAppServerV2EventProducer,
} from "./codexAppServerProducer.js";
import {
  RelayAgentTranscriptLifecycleRuntime,
  RelayAgentTrustedSourceIngressLease,
} from "./runtime.js";

const MAX_ID_UTF8_BYTES = 128;
const MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES = 4_096;

export const CODEX_TRUSTED_SOURCE_PRODUCER_LIMITS = Object.freeze({
  maxInputBytes: 131_072,
  maxPendingEvents: 64,
  maxRememberedEvents: 4_096,
});

export type CodexTrustedSourceCompositionState =
  | "disabled"
  | "enabling"
  | "enabled"
  | "closing"
  | "sealed"
  | "closed";

export type CodexTrustedSourceCompositionErrorCode =
  | "DISABLED"
  | "ALREADY_ENABLED"
  | "INVALID_SOURCE_LEASE"
  | "SOURCE_BINDING_MISMATCH"
  | "ATTACH_FAILED"
  | "SEALED"
  | "CLOSING"
  | "CLOSED"
  | "SOURCE_CLOSE_FAILED"
  | "PRODUCER_CLOSE_FAILED";

const ERROR_MESSAGES: Readonly<Record<CodexTrustedSourceCompositionErrorCode, string>> =
  Object.freeze({
    DISABLED: "Codex trusted-source composition is disabled",
    ALREADY_ENABLED: "Codex trusted-source composition was already enabled",
    INVALID_SOURCE_LEASE: "Codex controlled source lease is invalid",
    SOURCE_BINDING_MISMATCH: "Codex controlled source binding cannot be proven",
    ATTACH_FAILED: "Codex controlled source could not be attached",
    SEALED: "Codex trusted-source composition is sealed",
    CLOSING: "Codex trusted-source composition is closing",
    CLOSED: "Codex trusted-source composition is closed",
    SOURCE_CLOSE_FAILED: "Codex controlled source close barrier failed",
    PRODUCER_CLOSE_FAILED: "Codex trusted-source producer close barrier failed",
  });

export class CodexTrustedSourceCompositionError extends Error {
  constructor(readonly code: CodexTrustedSourceCompositionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexTrustedSourceCompositionError";
  }
}

export type CodexControlledSourceEventSink = (notificationBytes: Uint8Array) => Promise<void>;

export interface CodexControlledSourceSubscription {
  closeAndDrain(): Promise<void>;
}

/**
 * Structural input accepted only by the opaque issuer primitive. A future
 * process controller remains responsible for authenticating the exact Codex
 * app-server process before it asks its issuer to sign this descriptor.
 */
export interface CodexControlledSourceLeaseDescriptor {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  backendInstanceKey: string;
  managedIncarnation: string;
  provider: typeof CODEX_APP_SERVER_V2_PROVIDER;
  providerVersion: typeof CODEX_APP_SERVER_V2_PROVIDER_VERSION;
  schemaVersion: typeof CODEX_APP_SERVER_V2_SCHEMA_VERSION;
  attach(eventSink: CodexControlledSourceEventSink): CodexControlledSourceSubscription;
}

declare const CODEX_CONTROLLED_SOURCE_RECEIVER_BRAND: unique symbol;
declare const CODEX_CONTROLLED_SOURCE_LEASE_BRAND: unique symbol;

export interface CodexControlledSourceReceiver {
  readonly [CODEX_CONTROLLED_SOURCE_RECEIVER_BRAND]: true;
}

/**
 * An issuer- and receiver-bound process-local receipt. It has no public data
 * shape; only the issuing authority and exact composition receiver can consume
 * it, once.
 */
export interface CodexControlledSourceLease {
  readonly [CODEX_CONTROLLED_SOURCE_LEASE_BRAND]: true;
}

export interface CodexTrustedSourceCompositionOptions {
  runtime: RelayAgentTranscriptLifecycleRuntime;
  canonicalResourceResolver: RelayV2CanonicalResourceResolverPort;
  controlledSourceIssuer: CodexControlledSourceLeaseIssuer;
  controlledSourceReceiver: CodexControlledSourceReceiver;
}

interface NormalizedSourceLease {
  binding: Readonly<{
    hostId: string;
    hostEpoch: string;
    scopeId: string;
    sessionId: string;
  }>;
  backendInstanceKey: string;
  managedIncarnation: string;
  provider: typeof CODEX_APP_SERVER_V2_PROVIDER;
  providerVersion: typeof CODEX_APP_SERVER_V2_PROVIDER_VERSION;
  schemaVersion: typeof CODEX_APP_SERVER_V2_SCHEMA_VERSION;
  attach(eventSink: CodexControlledSourceEventSink): unknown;
}

interface NormalizedSubscription {
  closeAndDrain(): unknown;
}

interface ControlledSourceReceiverRecord {
  issuerIdentity: object;
  claimedBy: object | null;
  issued: boolean;
}

interface ControlledSourceLeaseRecord {
  issuerIdentity: object;
  receiverIdentity: object;
  descriptor: Readonly<Record<string, unknown>>;
  attachThis: object;
  consumed: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const controlledSourceIssuers = new WeakMap<object, object>();
const controlledSourceReceivers = new WeakMap<object, ControlledSourceReceiverRecord>();
const controlledSourceLeases = new WeakMap<object, ControlledSourceLeaseRecord>();

function compositionError(
  code: CodexTrustedSourceCompositionErrorCode,
): CodexTrustedSourceCompositionError {
  return new CodexTrustedSourceCompositionError(code);
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

function exactDataObject(
  value: unknown,
  keys: readonly string[],
  requireFrozen: boolean,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || !isPlainObject(value)
    || (requireFrozen && !Object.isFrozen(value))) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || (requireFrozen && (descriptor.configurable || descriptor.writable))) {
      throw compositionError("INVALID_SOURCE_LEASE");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function opaqueReceipt(value: unknown): object {
  if (typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== null
    || !Object.isFrozen(value)
    || Reflect.ownKeys(value).length !== 0) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  return value;
}

function issuerIdentity(value: unknown): object {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  const identity = controlledSourceIssuers.get(value);
  if (identity === undefined) throw compositionError("INVALID_SOURCE_LEASE");
  return identity;
}

function captureSourceDescriptor(
  value: unknown,
): { descriptor: Readonly<Record<string, unknown>>; attachThis: object } {
  const descriptor = exactDataObject(value, [
    "hostId",
    "hostEpoch",
    "scopeId",
    "sessionId",
    "backendInstanceKey",
    "managedIncarnation",
    "provider",
    "providerVersion",
    "schemaVersion",
    "attach",
  ], true);
  if (typeof descriptor.attach !== "function" || nodeTypes.isProxy(descriptor.attach)) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  return { descriptor, attachThis: value as object };
}

/**
 * Process-local opaque receipt primitive for a future trusted controller.
 * Constructing this object does not authenticate a process; production must
 * keep the exact instance inside the real controller/issuer boundary and call
 * issue only after that controller has authenticated the app-server process.
 */
export class CodexControlledSourceLeaseIssuer {
  readonly #identity: object;

  constructor() {
    this.#identity = Object.freeze({});
    controlledSourceIssuers.set(this, this.#identity);
    Object.freeze(this);
  }

  createReceiver(): CodexControlledSourceReceiver {
    const identity = this.#identity;
    if (controlledSourceIssuers.get(this) !== identity) {
      throw compositionError("INVALID_SOURCE_LEASE");
    }
    const receiver = Object.freeze(Object.create(null)) as CodexControlledSourceReceiver;
    controlledSourceReceivers.set(receiver, {
      issuerIdentity: identity,
      claimedBy: null,
      issued: false,
    });
    return receiver;
  }

  issue(
    receiverInput: CodexControlledSourceReceiver,
    descriptorInput: CodexControlledSourceLeaseDescriptor,
  ): CodexControlledSourceLease {
    const identity = this.#identity;
    if (controlledSourceIssuers.get(this) !== identity) {
      throw compositionError("INVALID_SOURCE_LEASE");
    }
    const receiver = opaqueReceipt(receiverInput);
    const receiverRecord = controlledSourceReceivers.get(receiver);
    if (receiverRecord === undefined
      || receiverRecord.issuerIdentity !== identity
      || receiverRecord.claimedBy === null
      || receiverRecord.issued) {
      throw compositionError("INVALID_SOURCE_LEASE");
    }
    const captured = captureSourceDescriptor(descriptorInput);
    const lease = Object.freeze(Object.create(null)) as CodexControlledSourceLease;
    receiverRecord.issued = true;
    controlledSourceLeases.set(lease, {
      issuerIdentity: identity,
      receiverIdentity: receiver,
      descriptor: captured.descriptor,
      attachThis: captured.attachThis,
      consumed: false,
    });
    return lease;
  }
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
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  return value;
}

function normalizeSourceLease(
  value: unknown,
  expectedIssuerIdentity: object,
  expectedReceiverIdentity: object,
): Readonly<NormalizedSourceLease> {
  const receipt = opaqueReceipt(value);
  const record = controlledSourceLeases.get(receipt);
  if (record === undefined
    || record.consumed
    || record.issuerIdentity !== expectedIssuerIdentity
    || record.receiverIdentity !== expectedReceiverIdentity) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  record.consumed = true;
  const lease = record.descriptor;
  if (lease.provider !== CODEX_APP_SERVER_V2_PROVIDER
    || lease.providerVersion !== CODEX_APP_SERVER_V2_PROVIDER_VERSION
    || lease.schemaVersion !== CODEX_APP_SERVER_V2_SCHEMA_VERSION
    || typeof lease.attach !== "function"
    || nodeTypes.isProxy(lease.attach)) {
    throw compositionError("INVALID_SOURCE_LEASE");
  }
  const binding = Object.freeze({
    hostId: opaque(lease.hostId),
    hostEpoch: opaque(lease.hostEpoch),
    scopeId: opaque(lease.scopeId),
    sessionId: opaque(lease.sessionId),
  });
  const attach = lease.attach as CodexControlledSourceLeaseDescriptor["attach"];
  return Object.freeze({
    binding,
    backendInstanceKey: opaque(
      lease.backendInstanceKey,
      MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES,
    ),
    managedIncarnation: opaque(lease.managedIncarnation),
    provider: CODEX_APP_SERVER_V2_PROVIDER,
    providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION,
    schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
    attach: (eventSink: CodexControlledSourceEventSink) => attach.call(
      record.attachThis,
      eventSink,
    ),
  });
}

function normalizeSubscription(value: unknown): Readonly<NormalizedSubscription> {
  const subscription = exactDataObject(value, ["closeAndDrain"], true);
  if (typeof subscription.closeAndDrain !== "function"
    || nodeTypes.isProxy(subscription.closeAndDrain)) {
    throw compositionError("ATTACH_FAILED");
  }
  const closeAndDrain = subscription.closeAndDrain as
    CodexControlledSourceSubscription["closeAndDrain"];
  return Object.freeze({
    closeAndDrain: () => closeAndDrain.call(value),
  });
}

function parseResolvedSessionTarget(
  value: unknown,
): Readonly<RelayV2CanonicalResolvedSessionTarget> {
  let target: Readonly<Record<string, unknown>>;
  let processTarget: Readonly<Record<string, unknown>>;
  let managedTarget: Readonly<Record<string, unknown>>;
  try {
    target = exactDataObject(value, [
      "authorization",
      "hostEpoch",
      "discoveryGeneration",
      "scopeId",
      "processTarget",
      "capabilities",
      "sessionId",
      "backendInstanceKey",
      "managedTarget",
    ], false);
    processTarget = exactDataObject(target.processTarget, ["kind", "targetId"], false);
    managedTarget = exactDataObject(
      target.managedTarget,
      ["name", "kind", "incarnation"],
      false,
    );
  } catch {
    throw compositionError("SOURCE_BINDING_MISMATCH");
  }
  if (target.authorization !== "evidence_only"
    || (processTarget.kind !== "local" && processTarget.kind !== "ssh")
    || (managedTarget.kind !== "worktree" && managedTarget.kind !== "terminal")
    || !Array.isArray(target.capabilities)
    || nodeTypes.isProxy(target.capabilities)) {
    throw compositionError("SOURCE_BINDING_MISMATCH");
  }
  try {
    const capabilityDescriptors = Object.getOwnPropertyDescriptors(target.capabilities);
    const capabilityKeys = Reflect.ownKeys(capabilityDescriptors);
    const lengthDescriptor = capabilityDescriptors.length;
    if (Object.getPrototypeOf(target.capabilities) !== Array.prototype
      || lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number"
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || capabilityKeys.length !== lengthDescriptor.value + 1) {
      throw compositionError("SOURCE_BINDING_MISMATCH");
    }
    const capabilities: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = capabilityDescriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw compositionError("SOURCE_BINDING_MISMATCH");
      }
      capabilities.push(opaque(descriptor.value));
    }
    return Object.freeze({
      authorization: "evidence_only" as const,
      hostEpoch: opaque(target.hostEpoch),
      discoveryGeneration: opaque(target.discoveryGeneration),
      scopeId: opaque(target.scopeId),
      processTarget: Object.freeze({
        kind: processTarget.kind,
        targetId: opaque(processTarget.targetId, MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES),
      }),
      capabilities: Object.freeze(capabilities),
      sessionId: opaque(target.sessionId),
      backendInstanceKey: opaque(
        target.backendInstanceKey,
        MAX_BACKEND_INSTANCE_KEY_UTF8_BYTES,
      ),
      managedTarget: Object.freeze({
        name: opaque(managedTarget.name),
        kind: managedTarget.kind,
        incarnation: opaque(managedTarget.incarnation),
      }),
    });
  } catch {
    throw compositionError("SOURCE_BINDING_MISMATCH");
  }
}

function requireNativePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) throw new TypeError("barrier did not return a native Promise");
  return value as Promise<unknown>;
}

/**
 * Default-off composition for one controller-authenticated Codex process
 * lease. It owns only local admission/close ordering; it creates no route,
 * capability, broker, relay-host, process-controller, or issuer state.
 */
export class CodexTrustedSourceComposition {
  readonly #runtime: RelayAgentTranscriptLifecycleRuntime;
  readonly #controlledSourceIssuerIdentity: object;
  readonly #controlledSourceReceiverIdentity: object;
  readonly #captureToken: (
    expectedHostEpoch: string,
  ) => Promise<RelayV2CanonicalResourceResolverToken>;
  readonly #resolveSession: RelayV2CanonicalResourceResolverPort["resolveSession"];
  readonly #sourceCloseContext = new AsyncLocalStorage<object>();
  readonly #sourceCloseReentryBarrier = Promise.resolve();

  #state: CodexTrustedSourceCompositionState = "disabled";
  #enableAttempt: object | null = null;
  #admissionAttempt: object | null = null;
  #producer: CodexAppServerV2EventProducer | null = null;
  #subscription: Readonly<NormalizedSubscription> | null = null;
  #attachBarrier: Deferred<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #sourceClosePhase: object | null = null;
  #fatal = false;

  constructor(options: CodexTrustedSourceCompositionOptions) {
    if (typeof options !== "object"
      || options === null
      || nodeTypes.isProxy(options)
      || typeof options.runtime !== "object"
      || options.runtime === null
      || nodeTypes.isProxy(options.runtime)
      || typeof options.runtime.store !== "object"
      || options.runtime.store === null
      || nodeTypes.isProxy(options.runtime.store)
      || typeof options.runtime.ingestTrustedSource !== "function"
      || nodeTypes.isProxy(options.runtime.ingestTrustedSource)
      || typeof options.canonicalResourceResolver !== "object"
      || options.canonicalResourceResolver === null
      || nodeTypes.isProxy(options.canonicalResourceResolver)
      || typeof options.canonicalResourceResolver.captureToken !== "function"
      || typeof options.canonicalResourceResolver.resolveSession !== "function"
      || nodeTypes.isProxy(options.canonicalResourceResolver.captureToken)
      || nodeTypes.isProxy(options.canonicalResourceResolver.resolveSession)) {
      throw new TypeError("Codex trusted-source composition dependencies are invalid");
    }
    let controlledSourceIssuerIdentity: object;
    let controlledSourceReceiverIdentity: object;
    let receiverRecord: ControlledSourceReceiverRecord | undefined;
    try {
      controlledSourceIssuerIdentity = issuerIdentity(options.controlledSourceIssuer);
      controlledSourceReceiverIdentity = opaqueReceipt(options.controlledSourceReceiver);
      receiverRecord = controlledSourceReceivers.get(controlledSourceReceiverIdentity);
    } catch {
      throw new TypeError("Codex trusted-source composition authority is invalid");
    }
    if (receiverRecord === undefined
      || receiverRecord.issuerIdentity !== controlledSourceIssuerIdentity
      || receiverRecord.claimedBy !== null
      || receiverRecord.issued) {
      throw new TypeError("Codex trusted-source composition authority is invalid");
    }
    receiverRecord.claimedBy = this;
    this.#runtime = options.runtime;
    this.#controlledSourceIssuerIdentity = controlledSourceIssuerIdentity;
    this.#controlledSourceReceiverIdentity = controlledSourceReceiverIdentity;
    this.#captureToken = options.canonicalResourceResolver.captureToken.bind(
      options.canonicalResourceResolver,
    );
    this.#resolveSession = options.canonicalResourceResolver.resolveSession.bind(
      options.canonicalResourceResolver,
    );
  }

  get state(): CodexTrustedSourceCompositionState {
    return this.#state;
  }

  get sourceEpoch(): string | null {
    return this.#producer?.source?.sourceEpoch ?? null;
  }

  enable(sourceLeaseInput: unknown): Promise<void> {
    if (this.#state !== "disabled") {
      if (this.#state === "enabling") {
        this.#fatal = true;
        this.#state = "sealed";
        this.#enableAttempt = null;
        this.#withdrawAdmission();
        void this.#ensureClose().catch(() => undefined);
      }
      return Promise.reject(compositionError(
        this.#state === "enabled" ? "ALREADY_ENABLED"
          : this.#state === "closing" ? "CLOSING"
            : this.#state === "closed" ? "CLOSED"
              : "SEALED",
      ));
    }
    const attempt = Object.freeze({});
    this.#state = "enabling";
    this.#enableAttempt = attempt;
    return this.#runEnable(attempt, sourceLeaseInput);
  }

  close(): Promise<void> {
    const sourceClosePhase = this.#sourceClosePhase;
    if (sourceClosePhase !== null
      && this.#sourceCloseContext.getStore() === sourceClosePhase) {
      return this.#sourceCloseReentryBarrier;
    }
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#state !== "sealed") this.#state = "closing";
    this.#enableAttempt = null;
    this.#withdrawAdmission();
    return this.#ensureClose();
  }

  async #runEnable(attempt: object, sourceLeaseInput: unknown): Promise<void> {
    let lease: Readonly<NormalizedSourceLease>;
    try {
      lease = normalizeSourceLease(
        sourceLeaseInput,
        this.#controlledSourceIssuerIdentity,
        this.#controlledSourceReceiverIdentity,
      );
    } catch {
      this.#failEnable();
      throw compositionError("INVALID_SOURCE_LEASE");
    }

    try {
      const owner = this.#runtime.store.owner;
      if (owner.hostId !== lease.binding.hostId || owner.hostEpoch !== lease.binding.hostEpoch) {
        throw compositionError("SOURCE_BINDING_MISMATCH");
      }
      const token = await this.#captureToken(lease.binding.hostEpoch);
      this.#assertEnableAttempt(attempt);
      const target = parseResolvedSessionTarget(await this.#resolveSession(
        token,
        lease.binding.scopeId,
        lease.binding.sessionId,
      ));
      this.#assertEnableAttempt(attempt);
      if (target.hostEpoch !== lease.binding.hostEpoch
        || target.scopeId !== lease.binding.scopeId
        || target.sessionId !== lease.binding.sessionId
        || target.backendInstanceKey !== lease.backendInstanceKey
        || target.managedTarget.incarnation !== lease.managedIncarnation
        || lease.provider !== CODEX_APP_SERVER_V2_PROVIDER
        || lease.providerVersion !== CODEX_APP_SERVER_V2_PROVIDER_VERSION
        || lease.schemaVersion !== CODEX_APP_SERVER_V2_SCHEMA_VERSION) {
        throw compositionError("SOURCE_BINDING_MISMATCH");
      }

      const ingress = new RelayAgentTrustedSourceIngressLease(this.#runtime);
      const producer = new CodexAppServerV2EventProducer(ingress);
      this.#producer = producer;
      const sourceEpoch = randomBytes(32).toString("base64url");
      producer.enable(Object.freeze({
        binding: lease.binding,
        source: Object.freeze({ sourceEpoch }),
        version: Object.freeze({
          provider: CODEX_APP_SERVER_V2_PROVIDER,
          providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION,
          schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
        }),
        limits: CODEX_TRUSTED_SOURCE_PRODUCER_LIMITS,
        correlation: null,
      }));
      this.#assertEnableAttempt(attempt);

      const attachBarrier = deferred<void>();
      this.#attachBarrier = attachBarrier;
      this.#admissionAttempt = attempt;
      const eventSink: CodexControlledSourceEventSink = Object.freeze(
        (notificationBytes: Uint8Array) => this.#acceptNotification(attempt, notificationBytes),
      );
      let attached: unknown;
      try {
        attached = lease.attach(eventSink);
        const subscription = normalizeSubscription(attached);
        this.#subscription = subscription;
      } catch {
        this.#withdrawAdmission();
        attachBarrier.resolve();
        this.#attachBarrier = null;
        if (this.#state === "closing" || this.#state === "closed") {
          await this.#ensureClose();
          throw compositionError("CLOSED");
        }
        this.#fatal = true;
        this.#state = "sealed";
        void this.#ensureClose().catch(() => undefined);
        throw compositionError("ATTACH_FAILED");
      }
      attachBarrier.resolve();
      this.#attachBarrier = null;

      if (this.#state !== "enabling"
        || this.#enableAttempt !== attempt
        || this.#admissionAttempt !== attempt
        || producer.state !== "enabled") {
        this.#withdrawAdmission();
        if (this.#state !== "closing" && this.#state !== "closed") {
          this.#fatal = true;
          this.#state = "sealed";
        }
        await this.#ensureClose();
        throw compositionError(this.#fatal ? "SEALED" : "CLOSED");
      }
      this.#enableAttempt = null;
      this.#state = "enabled";
    } catch (error) {
      if (error instanceof CodexTrustedSourceCompositionError
        && (error.code === "ATTACH_FAILED"
          || error.code === "CLOSED"
          || error.code === "SEALED")) {
        throw error;
      }
      if (this.#state === "closing" || this.#state === "closed") {
        throw compositionError("CLOSED");
      }
      this.#failEnable();
      throw compositionError("SOURCE_BINDING_MISMATCH");
    }
  }

  #assertEnableAttempt(attempt: object): void {
    if (this.#state !== "enabling" || this.#enableAttempt !== attempt) {
      throw compositionError(
        this.#state === "closing" || this.#state === "closed" ? "CLOSED" : "SEALED",
      );
    }
  }

  #acceptNotification(attempt: object, notificationBytes: Uint8Array): Promise<void> {
    if (this.#admissionAttempt !== attempt
      || (this.#state !== "enabling" && this.#state !== "enabled")) {
      return Promise.reject(compositionError(
        this.#state === "closing" ? "CLOSING"
          : this.#state === "closed" ? "CLOSED"
            : "SEALED",
      ));
    }
    if (nodeTypes.isProxy(notificationBytes) || !(notificationBytes instanceof Uint8Array)) {
      this.#sealFromCallback();
      return Promise.reject(compositionError("SEALED"));
    }
    const copied = new Uint8Array(notificationBytes);
    let accepted: Promise<unknown>;
    try {
      accepted = this.#producer!.accept(copied);
    } catch {
      this.#sealFromCallback();
      return Promise.reject(compositionError("SEALED"));
    }
    return accepted.then(
      () => undefined,
      (error) => {
        this.#sealFromCallback();
        throw error;
      },
    );
  }

  #sealFromCallback(): void {
    if (this.#state === "closed" || this.#state === "closing" || this.#state === "sealed") return;
    this.#fatal = true;
    this.#state = "sealed";
    this.#enableAttempt = null;
    this.#withdrawAdmission();
    void this.#ensureClose().catch(() => undefined);
  }

  #failEnable(): void {
    this.#fatal = true;
    this.#state = "sealed";
    this.#enableAttempt = null;
    this.#withdrawAdmission();
    void this.#ensureClose().catch(() => undefined);
  }

  #withdrawAdmission(): void {
    if (this.#admissionAttempt === null) return;
    this.#admissionAttempt = null;
  }

  #ensureClose(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    const completion = deferred<void>();
    this.#closePromise = completion.promise;
    void this.#runClose().then(completion.resolve, completion.reject);
    return this.#closePromise;
  }

  async #runClose(): Promise<void> {
    const attachBarrier = this.#attachBarrier;
    if (attachBarrier !== null) await attachBarrier.promise;

    let failure: CodexTrustedSourceCompositionErrorCode | null = null;
    const subscription = this.#subscription;
    this.#subscription = null;
    if (subscription !== null) {
      const sourceClosePhase = Object.freeze({});
      this.#sourceClosePhase = sourceClosePhase;
      try {
        const sourceClose = this.#sourceCloseContext.run(
          sourceClosePhase,
          () => requireNativePromise(subscription.closeAndDrain()),
        );
        await sourceClose;
      } catch {
        this.#fatal = true;
        failure = "SOURCE_CLOSE_FAILED";
      } finally {
        if (this.#sourceClosePhase === sourceClosePhase) this.#sourceClosePhase = null;
      }
    }

    const producer = this.#producer;
    if (producer !== null) {
      try {
        await requireNativePromise(producer.close());
      } catch {
        this.#fatal = true;
        failure ??= "PRODUCER_CLOSE_FAILED";
      }
    }

    this.#state = this.#fatal ? "sealed" : "closed";
    if (failure !== null) throw compositionError(failure);
  }
}
