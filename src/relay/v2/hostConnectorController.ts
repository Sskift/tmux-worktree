import type { RelayV2HostCarrierStatus } from "./hostCarrier.js";
import {
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
} from "./hostCredentialAuthority.js";
import { isRelayV2AuthIdentifier } from "./token.js";

const MAX_COUNTER = 18_446_744_073_709_551_615n;
const MAX_IDENTIFIER_BYTES = 128;
const EMPTY_CAPABILITY_INTERSECTION: readonly [] = Object.freeze([]);

type MaybePromise<T> = T | Promise<T>;
type DataRecord = Record<string, unknown>;

export interface RelayV2HostConnectorControllerIdentity {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
}

export interface RelayV2HostConnectorControllerBinding
extends RelayV2HostConnectorControllerIdentity {
  readonly controllerGeneration: string;
  readonly connectorId: string | null;
}

export type RelayV2HostConnectorControllerCut =
  | Readonly<{
      status: "stopped";
      controllerGeneration: string;
    }>
  | (Readonly<{
      status: "starting";
      connectorId: null;
    }> & Omit<RelayV2HostConnectorControllerBinding, "connectorId">)
  | (Readonly<{
      status: "registered";
      connectorId: string;
      acknowledgement: "host.registered";
      negotiatedCapabilityIntersection: readonly [];
    }> & Omit<RelayV2HostConnectorControllerBinding, "connectorId">)
  | (Readonly<{
      status: "failed";
      retryable: boolean;
    }> & RelayV2HostConnectorControllerBinding)
  | (Readonly<{
      status: "superseded";
    }> & RelayV2HostConnectorControllerBinding);

export interface RelayV2HostConnectorControllerStartInput
extends RelayV2HostConnectorControllerIdentity {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface RelayV2HostConnectorControllerStartResult
extends RelayV2HostConnectorControllerIdentity {
  readonly status: "started";
  readonly requestId: string;
  readonly controllerGeneration: string;
  readonly connectorId: string;
}

export interface RelayV2HostConnectorControllerStopInput
extends RelayV2HostConnectorControllerBinding {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface RelayV2HostConnectorControllerStopResult
extends RelayV2HostConnectorControllerBinding {
  readonly status: "stopped_and_drained";
  readonly requestId: string;
}

export interface RelayV2HostConnectorControllerPort {
  inspectCut(): MaybePromise<RelayV2HostConnectorControllerCut>;
  start(
    input: Readonly<RelayV2HostConnectorControllerStartInput>,
  ): Promise<RelayV2HostConnectorControllerStartResult>;
  stopAndDrain(
    input: Readonly<RelayV2HostConnectorControllerStopInput>,
  ): Promise<RelayV2HostConnectorControllerStopResult>;
}

export type RelayV2HostConnectorControllerErrorCode =
  | "ABORTED"
  | "BUSY"
  | "UNAVAILABLE"
  | "SUPERSEDED"
  | "OPERATION_FAILED";

export class RelayV2HostConnectorControllerError extends Error {
  constructor(readonly code: RelayV2HostConnectorControllerErrorCode) {
    super("Relay v2 host connector controller operation failed");
    this.name = "RelayV2HostConnectorControllerError";
  }
}

export interface RelayV2HostConnectorAttemptStartInput
extends RelayV2HostConnectorControllerStartInput {
  readonly controllerGeneration: string;
  readonly onCarrierStatus: (status: Readonly<RelayV2HostCarrierStatus>) => void;
}

export interface RelayV2HostConnectorAttemptDrainInput {
  readonly controllerGeneration: string;
  readonly carrierGeneration: number | null;
  readonly connectorId: string | null;
}

export interface RelayV2HostConnectorAttemptDrainEvidence
extends RelayV2HostConnectorAttemptDrainInput {
  readonly status: "closed_and_drained";
}

export interface RelayV2HostConnectorAttemptPort {
  disposeAndDrain(
    input: Readonly<RelayV2HostConnectorAttemptDrainInput>,
  ): MaybePromise<RelayV2HostConnectorAttemptDrainEvidence>;
}

export interface RelayV2HostConnectorAttemptFactoryPort {
  startAttempt(
    input: Readonly<RelayV2HostConnectorAttemptStartInput>,
  ): MaybePromise<RelayV2HostConnectorAttemptPort>;
}

export interface RelayV2HostConnectorControllerOptions
extends RelayV2HostConnectorControllerIdentity {
  readonly attempts: RelayV2HostConnectorAttemptFactoryPort;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface CapturedAttemptPort {
  readonly receiver: object;
  readonly disposeAndDrain: RelayV2HostConnectorAttemptPort["disposeAndDrain"];
}

interface AttemptRecord extends RelayV2HostConnectorControllerIdentity {
  readonly controllerGeneration: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly startDeferred: Deferred<RelayV2HostConnectorControllerStartResult>;
  readonly handleDeferred: Deferred<CapturedAttemptPort | null>;
  readonly abortListener: () => void;
  phase: "starting" | "registered" | "failed" | "superseded";
  connectorId: string | null;
  carrierGeneration: number | null;
  retryable: boolean | null;
  registrationObserved: boolean;
  acceptingStatus: boolean;
  factorySettled: boolean;
  startSettled: boolean;
  explicitStop: boolean;
  drainPromise: Promise<void> | null;
  drainFailed: boolean;
}

interface DrainedBinding extends RelayV2HostConnectorControllerBinding {}

interface ParsedCarrierStatus {
  readonly phase: "connecting" | "registered" | "offline" | "superseded";
  readonly generation: number;
  readonly connectorId: string | null;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function failure(code: RelayV2HostConnectorControllerErrorCode): RelayV2HostConnectorControllerError {
  return new RelayV2HostConnectorControllerError(code);
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value)) throw failure("OPERATION_FAILED");
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure("OPERATION_FAILED");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) throw failure("OPERATION_FAILED");
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function ownData(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function identifier(value: unknown): string {
  if (!isRelayV2AuthIdentifier(value)
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) {
    throw failure("OPERATION_FAILED");
  }
  return value;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function credentialReference(value: unknown): string {
  const reference = identifier(value);
  if (!reference.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || reference.length === RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length) {
    throw failure("OPERATION_FAILED");
  }
  return reference;
}

function counter(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw failure("OPERATION_FAILED");
  }
  try {
    if (BigInt(value) > MAX_COUNTER) throw failure("OPERATION_FAILED");
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw failure("OPERATION_FAILED");
  }
  return value;
}

function carrierGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw failure("OPERATION_FAILED");
  }
  return value as number;
}

function parseCarrierStatus(value: unknown): ParsedCarrierStatus {
  const phase = ownData(value, "phase");
  if (phase === "connecting") {
    const fields = exactDataObject(value, ["phase", "generation", "connectorId"]);
    if (fields.connectorId !== null) throw failure("OPERATION_FAILED");
    return Object.freeze({
      phase,
      generation: carrierGeneration(fields.generation),
      connectorId: null,
    });
  }
  if (phase === "registered") {
    const fields = exactDataObject(value, [
      "phase", "generation", "connectorId", "disposition",
    ]);
    if (fields.disposition !== "connected" && fields.disposition !== "replaced") {
      throw failure("OPERATION_FAILED");
    }
    return Object.freeze({
      phase,
      generation: carrierGeneration(fields.generation),
      connectorId: identifier(fields.connectorId),
    });
  }
  if (phase === "offline") {
    const fields = exactDataObject(value, [
      "phase", "generation", "connectorId", "closeCode",
    ]);
    if (!Number.isSafeInteger(fields.closeCode)
      || (fields.closeCode as number) < 1000
      || (fields.closeCode as number) > 4999) throw failure("OPERATION_FAILED");
    return Object.freeze({
      phase,
      generation: carrierGeneration(fields.generation),
      connectorId: nullableIdentifier(fields.connectorId),
    });
  }
  if (phase === "superseded") {
    const base = ["phase", "generation", "connectorId", "closeCode"];
    const hasWinner = ownData(value, "winningConnectorId") !== undefined
      || ownData(value, "winningHostInstanceId") !== undefined;
    const fields = exactDataObject(value, hasWinner
      ? [...base, "winningConnectorId", "winningHostInstanceId"]
      : base);
    if (fields.closeCode !== 4409) throw failure("OPERATION_FAILED");
    if (hasWinner) {
      identifier(fields.winningConnectorId);
      identifier(fields.winningHostInstanceId);
    }
    return Object.freeze({
      phase,
      generation: carrierGeneration(fields.generation),
      connectorId: nullableIdentifier(fields.connectorId),
    });
  }
  throw failure("OPERATION_FAILED");
}

function captureAttemptPort(value: unknown): CapturedAttemptPort {
  const fields = exactDataObject(value, ["disposeAndDrain"]);
  if (typeof fields.disposeAndDrain !== "function" || !isObject(value)) {
    throw failure("OPERATION_FAILED");
  }
  return Object.freeze({
    receiver: value,
    disposeAndDrain: fields.disposeAndDrain as RelayV2HostConnectorAttemptPort["disposeAndDrain"],
  });
}

function controllerErrorCode(error: unknown): RelayV2HostConnectorControllerErrorCode | null {
  if (ownData(error, "name") !== "RelayV2HostConnectorControllerError") return null;
  switch (ownData(error, "code")) {
    case "ABORTED":
    case "BUSY":
    case "UNAVAILABLE":
    case "SUPERSEDED":
    case "OPERATION_FAILED":
      return ownData(error, "code") as RelayV2HostConnectorControllerErrorCode;
    default:
      return null;
  }
}

/**
 * Default-off Host lifecycle owner. It consumes only a caller-injected attempt
 * factory and canonical HostCarrier status/drain evidence; it creates no
 * socket, process, credential, readiness source, retry, timer, or raw-frame
 * path and has no production composition callsite.
 */
export class RelayV2HostConnectorController
implements RelayV2HostConnectorControllerPort {
  readonly #startAttempt: RelayV2HostConnectorAttemptFactoryPort["startAttempt"];
  readonly #attemptFactory: object;
  readonly #hostId: string;
  readonly #hostEpoch: string;
  readonly #hostInstanceId: string;
  readonly #credentialReference: string;
  #generation = 0n;
  #current: AttemptRecord | null = null;
  #lastDrained: DrainedBinding | null = null;
  #permanentlySuperseded = false;
  #drainPoisoned = false;

  constructor(options: RelayV2HostConnectorControllerOptions) {
    const fields = exactDataObject(options, [
      "attempts", "hostId", "hostEpoch", "hostInstanceId", "credentialReference",
    ]);
    const startAttempt = ownData(fields.attempts, "startAttempt");
    if (!isObject(fields.attempts) || typeof startAttempt !== "function") {
      throw failure("OPERATION_FAILED");
    }
    this.#attemptFactory = fields.attempts;
    this.#startAttempt = startAttempt as RelayV2HostConnectorAttemptFactoryPort["startAttempt"];
    this.#hostId = identifier(fields.hostId);
    this.#hostEpoch = identifier(fields.hostEpoch);
    this.#hostInstanceId = identifier(fields.hostInstanceId);
    this.#credentialReference = credentialReference(fields.credentialReference);
  }

  inspectCut(): RelayV2HostConnectorControllerCut {
    const attempt = this.#current;
    if (attempt === null) {
      return Object.freeze({
        status: "stopped",
        controllerGeneration: this.#generation.toString(10),
      });
    }
    const binding = this.#binding(attempt);
    switch (attempt.phase) {
      case "starting":
        return Object.freeze({ status: "starting", ...binding, connectorId: null });
      case "registered":
        return Object.freeze({
          status: "registered",
          ...binding,
          connectorId: attempt.connectorId as string,
          acknowledgement: "host.registered",
          negotiatedCapabilityIntersection: EMPTY_CAPABILITY_INTERSECTION,
        });
      case "failed":
        return Object.freeze({
          status: "failed",
          ...binding,
          retryable: attempt.retryable === true,
        });
      case "superseded":
        return Object.freeze({ status: "superseded", ...binding });
    }
  }

  start(
    input: Readonly<RelayV2HostConnectorControllerStartInput>,
  ): Promise<RelayV2HostConnectorControllerStartResult> {
    let parsed: RelayV2HostConnectorControllerStartInput;
    try {
      parsed = this.#parseStartInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#permanentlySuperseded) return Promise.reject(failure("SUPERSEDED"));
    if (this.#drainPoisoned) return Promise.reject(failure("OPERATION_FAILED"));
    const incumbent = this.#current;
    if (incumbent !== null && !incumbent.startSettled) {
      return incumbent.requestId === parsed.requestId
        ? incumbent.startDeferred.promise
        : Promise.reject(failure("BUSY"));
    }
    if (incumbent?.explicitStop || incumbent?.drainFailed) {
      return Promise.reject(failure(incumbent.drainFailed ? "OPERATION_FAILED" : "BUSY"));
    }
    if (incumbent?.phase === "starting") {
      return incumbent.requestId === parsed.requestId
        ? incumbent.startDeferred.promise
        : Promise.reject(failure("BUSY"));
    }
    if (incumbent?.phase === "registered") {
      if (incumbent.requestId === parsed.requestId) {
        return Promise.resolve(this.#startResult(incumbent));
      }
      return Promise.reject(failure("BUSY"));
    }
    if (incumbent?.phase === "superseded") {
      return Promise.reject(failure("SUPERSEDED"));
    }
    if (incumbent?.phase === "failed" && incumbent.retryable !== true) {
      return Promise.reject(failure("OPERATION_FAILED"));
    }
    if (parsed.signal.aborted) return Promise.reject(failure("ABORTED"));
    if (this.#generation === MAX_COUNTER) return Promise.reject(failure("OPERATION_FAILED"));

    const predecessor = incumbent?.phase === "failed" ? incumbent : null;
    this.#generation += 1n;
    const startDeferred = deferred<RelayV2HostConnectorControllerStartResult>();
    const handleDeferred = deferred<CapturedAttemptPort | null>();
    let record!: AttemptRecord;
    const abortListener = () => this.#abort(record);
    record = {
      controllerGeneration: this.#generation.toString(10),
      requestId: parsed.requestId,
      signal: parsed.signal,
      hostId: this.#hostId,
      hostEpoch: this.#hostEpoch,
      hostInstanceId: this.#hostInstanceId,
      credentialReference: this.#credentialReference,
      startDeferred,
      handleDeferred,
      abortListener,
      phase: "starting",
      connectorId: null,
      carrierGeneration: null,
      retryable: null,
      registrationObserved: false,
      acceptingStatus: true,
      factorySettled: false,
      startSettled: false,
      explicitStop: false,
      drainPromise: null,
      drainFailed: false,
    };
    this.#current = record;
    parsed.signal.addEventListener("abort", abortListener, { once: true });
    void this.#openAttempt(record, predecessor);
    return startDeferred.promise;
  }

  stopAndDrain(
    input: Readonly<RelayV2HostConnectorControllerStopInput>,
  ): Promise<RelayV2HostConnectorControllerStopResult> {
    let parsed: RelayV2HostConnectorControllerStopInput;
    try {
      parsed = this.#parseStopInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#matchesBinding(this.#lastDrained, parsed)) {
      return Promise.resolve(this.#stopResult(parsed));
    }
    if (this.#drainPoisoned) return Promise.reject(failure("OPERATION_FAILED"));
    const attempt = this.#current;
    if (attempt === null || !this.#matchesBinding(this.#binding(attempt), parsed)) {
      return Promise.reject(failure(this.#permanentlySuperseded ? "SUPERSEDED" : "UNAVAILABLE"));
    }
    if (attempt.phase === "superseded") {
      return this.#ensureDrain(attempt).then(() => {
        throw failure("SUPERSEDED");
      });
    }
    attempt.explicitStop = true;
    attempt.acceptingStatus = false;
    this.#rejectStart(attempt, "ABORTED");
    return this.#ensureDrain(attempt).then(() => {
      if (this.#current === attempt) this.#current = null;
      this.#lastDrained = this.#binding(attempt);
      return this.#stopResult(parsed);
    }).catch(() => {
      attempt.phase = "failed";
      attempt.retryable = false;
      attempt.drainFailed = true;
      throw failure("OPERATION_FAILED");
    });
  }

  async #openAttempt(
    record: AttemptRecord,
    predecessor: AttemptRecord | null,
  ): Promise<void> {
    if (predecessor !== null) {
      predecessor.acceptingStatus = false;
      try {
        await this.#ensureDrain(predecessor);
      } catch {
        this.#failAttempt(record, "OPERATION_FAILED", false, true);
        record.factorySettled = true;
        record.handleDeferred.resolve(null);
        return;
      }
    }
    if (this.#current !== record || record.phase !== "starting" || !record.acceptingStatus) {
      record.factorySettled = true;
      record.handleDeferred.resolve(null);
      return;
    }
    try {
      const raw = await Reflect.apply(this.#startAttempt, this.#attemptFactory, [Object.freeze({
        requestId: record.requestId,
        controllerGeneration: record.controllerGeneration,
        hostId: record.hostId,
        hostEpoch: record.hostEpoch,
        hostInstanceId: record.hostInstanceId,
        credentialReference: record.credentialReference,
        signal: record.signal,
        onCarrierStatus: (status: Readonly<RelayV2HostCarrierStatus>) => {
          this.#receiveCarrierStatus(record, status);
        },
      })]);
      const captured = captureAttemptPort(raw);
      record.factorySettled = true;
      record.handleDeferred.resolve(captured);
      if (this.#current !== record || !record.acceptingStatus || record.explicitStop) {
        void this.#ensureDrain(record).catch(() => undefined);
        return;
      }
      if (record.registrationObserved) {
        record.phase = "registered";
        this.#resolveStart(record);
      }
    } catch (error) {
      record.factorySettled = true;
      record.handleDeferred.resolve(null);
      if (this.#current !== record || record.phase === "superseded") return;
      const code = controllerErrorCode(error) ?? "OPERATION_FAILED";
      this.#failAttempt(
        record,
        code,
        code === "ABORTED" || code === "BUSY" || code === "UNAVAILABLE",
        true,
      );
    }
  }

  #receiveCarrierStatus(record: AttemptRecord, value: unknown): void {
    if (this.#current !== record || !record.acceptingStatus) return;
    let status: ParsedCarrierStatus;
    try {
      status = parseCarrierStatus(value);
      if (record.carrierGeneration === null) record.carrierGeneration = status.generation;
      else if (record.carrierGeneration !== status.generation) throw failure("OPERATION_FAILED");
      if (record.connectorId !== null
        && status.connectorId !== null
        && record.connectorId !== status.connectorId) throw failure("OPERATION_FAILED");
    } catch {
      this.#failAttempt(record, "OPERATION_FAILED", false, true);
      return;
    }
    switch (status.phase) {
      case "connecting":
        if (record.phase !== "starting" || record.registrationObserved) {
          this.#failAttempt(record, "OPERATION_FAILED", false, true);
        }
        return;
      case "registered":
        if (record.phase === "failed" || record.phase === "superseded") return;
        record.connectorId = status.connectorId;
        record.registrationObserved = true;
        record.retryable = null;
        if (record.factorySettled) {
          record.phase = "registered";
          this.#resolveStart(record);
        }
        return;
      case "offline":
        if (record.phase === "failed" || record.phase === "superseded") return;
        record.connectorId = status.connectorId ?? record.connectorId;
        this.#failAttempt(record, "UNAVAILABLE", true, false);
        return;
      case "superseded":
        record.connectorId = status.connectorId ?? record.connectorId;
        record.phase = "superseded";
        record.retryable = null;
        record.acceptingStatus = false;
        this.#permanentlySuperseded = true;
        this.#rejectStart(record, "SUPERSEDED");
        void this.#ensureDrain(record).catch(() => undefined);
    }
  }

  #abort(record: AttemptRecord): void {
    if (this.#current !== record || record.startSettled || record.phase !== "starting") return;
    record.acceptingStatus = false;
    record.phase = "failed";
    record.retryable = true;
    void this.#ensureDrain(record).then(
      () => this.#rejectStart(record, "ABORTED"),
      () => {
        record.drainFailed = true;
        record.retryable = false;
        this.#rejectStart(record, "OPERATION_FAILED");
      },
    );
  }

  #failAttempt(
    record: AttemptRecord,
    code: RelayV2HostConnectorControllerErrorCode,
    retryable: boolean,
    drain: boolean,
  ): void {
    if (record.phase === "superseded") return;
    record.phase = code === "SUPERSEDED" ? "superseded" : "failed";
    record.retryable = retryable;
    record.acceptingStatus = false;
    if (code === "SUPERSEDED") this.#permanentlySuperseded = true;
    this.#rejectStart(record, code);
    if (drain) void this.#ensureDrain(record).catch(() => undefined);
  }

  #resolveStart(record: AttemptRecord): void {
    if (record.startSettled || record.phase !== "registered" || record.connectorId === null) return;
    record.startSettled = true;
    record.signal.removeEventListener("abort", record.abortListener);
    record.startDeferred.resolve(this.#startResult(record));
  }

  #rejectStart(
    record: AttemptRecord,
    code: RelayV2HostConnectorControllerErrorCode,
  ): void {
    if (record.startSettled) return;
    record.startSettled = true;
    record.signal.removeEventListener("abort", record.abortListener);
    record.startDeferred.reject(failure(code));
  }

  #ensureDrain(record: AttemptRecord): Promise<void> {
    if (record.drainPromise !== null) return record.drainPromise;
    record.acceptingStatus = false;
    record.drainPromise = (async () => {
      const captured = await record.handleDeferred.promise;
      if (captured === null) return;
      const input = Object.freeze({
        controllerGeneration: record.controllerGeneration,
        carrierGeneration: record.carrierGeneration,
        connectorId: record.connectorId,
      });
      const raw = await Reflect.apply(captured.disposeAndDrain, captured.receiver, [input]);
      const fields = exactDataObject(raw, [
        "status", "controllerGeneration", "carrierGeneration", "connectorId",
      ]);
      if (fields.status !== "closed_and_drained"
        || counter(fields.controllerGeneration) !== record.controllerGeneration
        || (fields.carrierGeneration === null
          ? null
          : carrierGeneration(fields.carrierGeneration)) !== record.carrierGeneration
        || nullableIdentifier(fields.connectorId) !== record.connectorId) {
        throw failure("OPERATION_FAILED");
      }
    })();
    void record.drainPromise.catch(() => {
      record.drainFailed = true;
      this.#drainPoisoned = true;
    });
    return record.drainPromise;
  }

  #parseStartInput(value: unknown): RelayV2HostConnectorControllerStartInput {
    const fields = exactDataObject(value, [
      "requestId", "hostId", "hostEpoch", "hostInstanceId", "credentialReference", "signal",
    ]);
    if (!(fields.signal instanceof AbortSignal)) throw failure("OPERATION_FAILED");
    const parsed = Object.freeze({
      requestId: identifier(fields.requestId),
      hostId: identifier(fields.hostId),
      hostEpoch: identifier(fields.hostEpoch),
      hostInstanceId: identifier(fields.hostInstanceId),
      credentialReference: credentialReference(fields.credentialReference),
      signal: fields.signal,
    });
    this.#validateIdentity(parsed);
    return parsed;
  }

  #parseStopInput(value: unknown): RelayV2HostConnectorControllerStopInput {
    const fields = exactDataObject(value, [
      "requestId", "controllerGeneration", "connectorId", "hostId", "hostEpoch",
      "hostInstanceId", "credentialReference", "signal",
    ]);
    if (!(fields.signal instanceof AbortSignal)) throw failure("OPERATION_FAILED");
    const parsed = Object.freeze({
      requestId: identifier(fields.requestId),
      controllerGeneration: counter(fields.controllerGeneration),
      connectorId: nullableIdentifier(fields.connectorId),
      hostId: identifier(fields.hostId),
      hostEpoch: identifier(fields.hostEpoch),
      hostInstanceId: identifier(fields.hostInstanceId),
      credentialReference: credentialReference(fields.credentialReference),
      signal: fields.signal,
    });
    this.#validateIdentity(parsed);
    return parsed;
  }

  #validateIdentity(identity: RelayV2HostConnectorControllerIdentity): void {
    if (identity.hostId !== this.#hostId
      || identity.hostEpoch !== this.#hostEpoch
      || identity.hostInstanceId !== this.#hostInstanceId
      || identity.credentialReference !== this.#credentialReference) {
      throw failure("OPERATION_FAILED");
    }
  }

  #binding(record: AttemptRecord): RelayV2HostConnectorControllerBinding {
    return Object.freeze({
      controllerGeneration: record.controllerGeneration,
      connectorId: record.phase === "starting" ? null : record.connectorId,
      hostId: record.hostId,
      hostEpoch: record.hostEpoch,
      hostInstanceId: record.hostInstanceId,
      credentialReference: record.credentialReference,
    });
  }

  #matchesBinding(
    binding: RelayV2HostConnectorControllerBinding | null,
    candidate: RelayV2HostConnectorControllerBinding,
  ): boolean {
    return binding !== null
      && binding.controllerGeneration === candidate.controllerGeneration
      && binding.connectorId === candidate.connectorId
      && binding.hostId === candidate.hostId
      && binding.hostEpoch === candidate.hostEpoch
      && binding.hostInstanceId === candidate.hostInstanceId
      && binding.credentialReference === candidate.credentialReference;
  }

  #startResult(
    record: AttemptRecord,
  ): RelayV2HostConnectorControllerStartResult {
    if (record.connectorId === null) throw failure("OPERATION_FAILED");
    return Object.freeze({
      status: "started",
      requestId: record.requestId,
      controllerGeneration: record.controllerGeneration,
      connectorId: record.connectorId,
      hostId: record.hostId,
      hostEpoch: record.hostEpoch,
      hostInstanceId: record.hostInstanceId,
      credentialReference: record.credentialReference,
    });
  }

  #stopResult(
    input: RelayV2HostConnectorControllerStopInput,
  ): RelayV2HostConnectorControllerStopResult {
    return Object.freeze({
      status: "stopped_and_drained",
      requestId: input.requestId,
      controllerGeneration: input.controllerGeneration,
      connectorId: input.connectorId,
      hostId: input.hostId,
      hostEpoch: input.hostEpoch,
      hostInstanceId: input.hostInstanceId,
      credentialReference: input.credentialReference,
    });
  }
}
