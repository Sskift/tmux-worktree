import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  RelayAgentSourceEvent,
  RelayAgentSourceMutation,
  RelayAgentTrustedAdapterBinding,
} from "./authority.js";
import type {
  RelayAgentTrustedSourceIngressLease,
  RelayAgentTrustedIngestResult,
} from "./runtime.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonValue,
} from "../../../v2/strictJson.js";

export const CODEX_APP_SERVER_V2_PROVIDER = "codex-app-server" as const;
export const CODEX_APP_SERVER_V2_PROVIDER_VERSION = "0.144.5" as const;
export const CODEX_APP_SERVER_V2_SCHEMA_VERSION = 2 as const;

const MAX_OPAQUE_ID_BYTES = 128;
const MAX_TEXT_BYTES = 65_536;
const MAX_PROVIDER_ERROR_BYTES = 8_192;
const MAX_INPUT_BYTES_HARD = 262_144;
const MAX_PENDING_EVENTS_HARD = 256;
const MAX_REMEMBERED_EVENTS_HARD = 10_000;
const MAX_TURN_ITEMS = 2_048;
const MAX_USER_CONTENT_PARTS = 256;
const MAX_SAFE_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

const JSON_LIMITS = Object.freeze({
  maxDepth: 24,
  maxDirectKeys: 32,
  maxTotalKeys: 8_192,
  maxNodes: 16_384,
});

type ProducerState = "disabled" | "enabling" | "enabled" | "closing" | "sealed" | "closed";

export type CodexAppServerProducerErrorCode =
  | "DISABLED"
  | "ALREADY_ENABLED"
  | "INVALID_CONFIG"
  | "INVALID_EVENT"
  | "CAPACITY"
  | "SEALED"
  | "CLOSING"
  | "CLOSED"
  | "DURABLE_REJECTED";

const ERROR_MESSAGES: Readonly<Record<CodexAppServerProducerErrorCode, string>> = Object.freeze({
  DISABLED: "Codex app-server producer is disabled",
  ALREADY_ENABLED: "Codex app-server producer is already enabled",
  INVALID_CONFIG: "Codex app-server producer configuration is invalid",
  INVALID_EVENT: "Codex app-server event does not match the frozen schema",
  CAPACITY: "Codex app-server producer capacity was exceeded",
  SEALED: "Codex app-server producer is sealed",
  CLOSING: "Codex app-server producer is closing",
  CLOSED: "Codex app-server producer is closed",
  DURABLE_REJECTED: "Codex app-server durable ingest was rejected",
});

export class CodexAppServerProducerError extends Error {
  constructor(readonly code: CodexAppServerProducerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAppServerProducerError";
  }
}

export interface CodexAppServerProducerLimits {
  maxInputBytes: number;
  maxPendingEvents: number;
  maxRememberedEvents: number;
}

export interface CodexAppServerProducerVersion {
  provider: typeof CODEX_APP_SERVER_V2_PROVIDER;
  providerVersion: typeof CODEX_APP_SERVER_V2_PROVIDER_VERSION;
  schemaVersion: typeof CODEX_APP_SERVER_V2_SCHEMA_VERSION;
}

export interface CodexAppServerProducerSource {
  sourceEpoch: string;
}

export interface CodexUserMessageCorrelation {
  provider: typeof CODEX_APP_SERVER_V2_PROVIDER;
  providerVersion: typeof CODEX_APP_SERVER_V2_PROVIDER_VERSION;
  schemaVersion: typeof CODEX_APP_SERVER_V2_SCHEMA_VERSION;
  sourceEpoch: string;
  threadId: string;
  turnId: string;
  itemId: string;
  clientId: string | null;
}

export interface CodexUserMessageCorrelationPort {
  commandIdForUserMessage(correlation: Readonly<CodexUserMessageCorrelation>): string | null;
}

export interface CodexAppServerProducerConfig {
  binding: Readonly<RelayAgentTrustedAdapterBinding>;
  source: Readonly<CodexAppServerProducerSource>;
  version: Readonly<CodexAppServerProducerVersion>;
  limits: Readonly<CodexAppServerProducerLimits>;
  correlation: Readonly<CodexUserMessageCorrelationPort> | null;
}

export interface CodexAppServerProducerResult {
  disposition: "applied" | "duplicate";
  upstreamEventId: string;
  firstSourceSeq: string;
  lastSourceSeq: string;
  sourceEventCount: number;
}

type JsonObject = { [key: string]: RelayV2JsonValue };

interface NormalizedConfig {
  binding: Readonly<RelayAgentTrustedAdapterBinding>;
  source: Readonly<CodexAppServerProducerSource>;
  version: Readonly<CodexAppServerProducerVersion>;
  limits: Readonly<CodexAppServerProducerLimits>;
  correlate: ((correlation: Readonly<CodexUserMessageCorrelation>) => string | null) | null;
}

interface DecodedTurn {
  id: string;
  items: readonly DecodedMessageItem[];
  itemsView: "notLoaded" | "summary" | "full";
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: JsonObject | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

interface DecodedUserMessage {
  type: "userMessage";
  id: string;
  clientId: string | null;
  text: string;
  fingerprint: string;
}

interface DecodedAgentMessage {
  type: "agentMessage";
  id: string;
  text: string;
  fingerprint: string;
}

type DecodedMessageItem = DecodedUserMessage | DecodedAgentMessage;

interface DecodedNotification {
  method: "turn/started" | "item/completed" | "turn/completed";
  threadId: string;
  turn: DecodedTurn | null;
  turnId: string;
  item: DecodedMessageItem | null;
  occurredAtMs: number;
  upstreamEventId: string;
  fingerprint: string;
}

interface ActiveTurn {
  threadId: string;
  upstreamTurnId: string;
  runId: string;
  turnId: string;
  observedItemIds: Set<string>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface QueueJob {
  result: Readonly<CodexAppServerProducerResult>;
  events: readonly Readonly<RelayAgentSourceEvent>[];
  deferred: Deferred<Readonly<CodexAppServerProducerResult>>;
}

interface DedupeRecord {
  fingerprint: string;
  result: Readonly<CodexAppServerProducerResult>;
  promise: Promise<Readonly<CodexAppServerProducerResult>>;
}

function producerError(code: CodexAppServerProducerErrorCode): CodexAppServerProducerError {
  return new CodexAppServerProducerError(code);
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

function frozenExactDataObject(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw producerError("INVALID_CONFIG");
  }
  if (!isPlainObject(value) || !Object.isFrozen(value)) throw producerError("INVALID_CONFIG");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw producerError("INVALID_CONFIG");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.configurable
      || descriptor.writable
      || !descriptor.enumerable
    ) {
      throw producerError("INVALID_CONFIG");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function positiveBoundedInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw producerError("INVALID_CONFIG");
  }
  return value;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function opaqueId(value: unknown, errorCode: "INVALID_CONFIG" | "INVALID_EVENT"): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || !isWellFormedUnicode(value)
    || utf8Length(value) > MAX_OPAQUE_ID_BYTES
  ) {
    throw producerError(errorCode);
  }
  return value;
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

function normalizeConfig(value: unknown): Readonly<NormalizedConfig> {
  const config = frozenExactDataObject(
    value,
    ["binding", "source", "version", "limits", "correlation"],
  );
  const bindingInput = frozenExactDataObject(
    config.binding,
    ["hostId", "hostEpoch", "scopeId", "sessionId"],
  );
  const sourceInput = frozenExactDataObject(config.source, ["sourceEpoch"]);
  const versionInput = frozenExactDataObject(
    config.version,
    ["provider", "providerVersion", "schemaVersion"],
  );
  const limitsInput = frozenExactDataObject(
    config.limits,
    ["maxInputBytes", "maxPendingEvents", "maxRememberedEvents"],
  );

  if (
    versionInput.provider !== CODEX_APP_SERVER_V2_PROVIDER
    || versionInput.providerVersion !== CODEX_APP_SERVER_V2_PROVIDER_VERSION
    || versionInput.schemaVersion !== CODEX_APP_SERVER_V2_SCHEMA_VERSION
  ) {
    throw producerError("INVALID_CONFIG");
  }

  let correlate: NormalizedConfig["correlate"] = null;
  if (config.correlation !== null) {
    const correlationInput = frozenExactDataObject(
      config.correlation,
      ["commandIdForUserMessage"],
    );
    if (typeof correlationInput.commandIdForUserMessage !== "function") {
      throw producerError("INVALID_CONFIG");
    }
    if (nodeTypes.isProxy(correlationInput.commandIdForUserMessage)) {
      throw producerError("INVALID_CONFIG");
    }
    correlate = correlationInput.commandIdForUserMessage as NormalizedConfig["correlate"];
  }

  return Object.freeze({
    binding: Object.freeze({
      hostId: opaqueId(bindingInput.hostId, "INVALID_CONFIG"),
      hostEpoch: opaqueId(bindingInput.hostEpoch, "INVALID_CONFIG"),
      scopeId: opaqueId(bindingInput.scopeId, "INVALID_CONFIG"),
      sessionId: opaqueId(bindingInput.sessionId, "INVALID_CONFIG"),
    }),
    source: Object.freeze({
      sourceEpoch: opaqueId(sourceInput.sourceEpoch, "INVALID_CONFIG"),
    }),
    version: Object.freeze({
      provider: CODEX_APP_SERVER_V2_PROVIDER,
      providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION,
      schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
    }),
    limits: Object.freeze({
      maxInputBytes: positiveBoundedInteger(limitsInput.maxInputBytes, MAX_INPUT_BYTES_HARD),
      maxPendingEvents: positiveBoundedInteger(
        limitsInput.maxPendingEvents,
        MAX_PENDING_EVENTS_HARD,
      ),
      maxRememberedEvents: positiveBoundedInteger(
        limitsInput.maxRememberedEvents,
        MAX_REMEMBERED_EVENTS_HARD,
      ),
    }),
    correlate,
  });
}

function closedJsonObject(
  value: RelayV2JsonValue,
  keys: readonly string[],
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw producerError("INVALID_EVENT");
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length
    || actualKeys.some((key) => !keys.includes(key))
  ) {
    throw producerError("INVALID_EVENT");
  }
  return value;
}

function jsonString(value: RelayV2JsonValue): string {
  if (typeof value !== "string") throw producerError("INVALID_EVENT");
  return value;
}

function nullableOpaqueId(value: RelayV2JsonValue): string | null {
  return value === null ? null : opaqueId(value, "INVALID_EVENT");
}

function nullableSafeInteger(value: RelayV2JsonValue): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw producerError("INVALID_EVENT");
  }
  return value;
}

function occurredAtFromSeconds(value: number | null): number {
  if (value === null || value > MAX_SAFE_SECONDS) throw producerError("INVALID_EVENT");
  return value * 1_000;
}

function occurredAtMilliseconds(value: RelayV2JsonValue): number {
  const parsed = nullableSafeInteger(value);
  if (parsed === null) throw producerError("INVALID_EVENT");
  return parsed;
}

function boundedText(value: RelayV2JsonValue): string {
  const text = jsonString(value);
  if (utf8Length(text) > MAX_TEXT_BYTES) throw producerError("INVALID_EVENT");
  return text;
}

function canonicalJson(value: RelayV2JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function digest(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("hex");
}

function parseUserMessage(value: RelayV2JsonValue): DecodedUserMessage {
  const item = closedJsonObject(value, ["type", "id", "clientId", "content"]);
  if (item.type !== "userMessage" || !Array.isArray(item.content)) {
    throw producerError("INVALID_EVENT");
  }
  if (item.content.length < 1 || item.content.length > MAX_USER_CONTENT_PARTS) {
    throw producerError("INVALID_EVENT");
  }
  let text = "";
  for (const rawPart of item.content) {
    const part = closedJsonObject(rawPart, ["type", "text", "text_elements"]);
    if (part.type !== "text" || !Array.isArray(part.text_elements) || part.text_elements.length !== 0) {
      throw producerError("INVALID_EVENT");
    }
    text += jsonString(part.text);
    if (utf8Length(text) > MAX_TEXT_BYTES) throw producerError("INVALID_EVENT");
  }
  return Object.freeze({
    type: "userMessage",
    id: opaqueId(item.id, "INVALID_EVENT"),
    clientId: nullableOpaqueId(item.clientId),
    text,
    fingerprint: digest(canonicalJson(item)),
  });
}

function parseAgentMessage(value: RelayV2JsonValue): DecodedAgentMessage {
  const item = closedJsonObject(value, ["type", "id", "text", "phase", "memoryCitation"]);
  if (
    item.type !== "agentMessage"
    || (item.phase !== null && item.phase !== "commentary" && item.phase !== "final_answer")
    || item.memoryCitation !== null
  ) {
    throw producerError("INVALID_EVENT");
  }
  return Object.freeze({
    type: "agentMessage",
    id: opaqueId(item.id, "INVALID_EVENT"),
    text: boundedText(item.text),
    fingerprint: digest(canonicalJson(item)),
  });
}

function parseMessageItem(value: RelayV2JsonValue): DecodedMessageItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw producerError("INVALID_EVENT");
  }
  if (value.type === "userMessage") return parseUserMessage(value);
  if (value.type === "agentMessage") return parseAgentMessage(value);
  throw producerError("INVALID_EVENT");
}

function parseTurnError(value: RelayV2JsonValue): JsonObject | null {
  if (value === null) return null;
  const error = closedJsonObject(value, ["message", "codexErrorInfo", "additionalDetails"]);
  const message = jsonString(error.message);
  const additionalDetails = error.additionalDetails === null
    ? null
    : jsonString(error.additionalDetails);
  if (
    utf8Length(message) > MAX_PROVIDER_ERROR_BYTES
    || (additionalDetails !== null && utf8Length(additionalDetails) > MAX_PROVIDER_ERROR_BYTES)
    || error.codexErrorInfo !== null
  ) {
    throw producerError("INVALID_EVENT");
  }
  return error;
}

function parseTurn(value: RelayV2JsonValue): DecodedTurn {
  const turn = closedJsonObject(
    value,
    ["id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs"],
  );
  if (!Array.isArray(turn.items) || turn.items.length > MAX_TURN_ITEMS) {
    throw producerError("INVALID_EVENT");
  }
  if (
    turn.itemsView !== "notLoaded"
    && turn.itemsView !== "summary"
    && turn.itemsView !== "full"
  ) {
    throw producerError("INVALID_EVENT");
  }
  if (
    turn.status !== "completed"
    && turn.status !== "interrupted"
    && turn.status !== "failed"
    && turn.status !== "inProgress"
  ) {
    throw producerError("INVALID_EVENT");
  }
  return Object.freeze({
    id: opaqueId(turn.id, "INVALID_EVENT"),
    items: Object.freeze(turn.items.map(parseMessageItem)),
    itemsView: turn.itemsView,
    status: turn.status,
    error: parseTurnError(turn.error),
    startedAt: nullableSafeInteger(turn.startedAt),
    completedAt: nullableSafeInteger(turn.completedAt),
    durationMs: nullableSafeInteger(turn.durationMs),
  });
}

function decodeNotification(bytes: Uint8Array): DecodedNotification {
  const root = parseRelayV2JsonObject(decodeRelayV2StrictUtf8(bytes), JSON_LIMITS);
  const envelope = closedJsonObject(root, ["method", "params"]);
  const method = envelope.method;
  if (
    method !== "turn/started"
    && method !== "item/completed"
    && method !== "turn/completed"
  ) {
    throw producerError("INVALID_EVENT");
  }

  if (method === "item/completed") {
    const params = closedJsonObject(
      envelope.params,
      ["item", "threadId", "turnId", "completedAtMs"],
    );
    const item = parseMessageItem(params.item);
    const threadId = opaqueId(params.threadId, "INVALID_EVENT");
    const turnId = opaqueId(params.turnId, "INVALID_EVENT");
    return Object.freeze({
      method,
      threadId,
      turn: null,
      turnId,
      item,
      occurredAtMs: occurredAtMilliseconds(params.completedAtMs),
      upstreamEventId: `${method}:${item.id}`,
      fingerprint: digest(canonicalJson(envelope)),
    });
  }

  const params = closedJsonObject(envelope.params, ["threadId", "turn"]);
  const turn = parseTurn(params.turn);
  const threadId = opaqueId(params.threadId, "INVALID_EVENT");
  const occurredAtMs = method === "turn/started"
    ? occurredAtFromSeconds(turn.startedAt)
    : occurredAtFromSeconds(turn.completedAt);
  return Object.freeze({
    method,
    threadId,
    turn,
    turnId: turn.id,
    item: null,
    occurredAtMs,
    upstreamEventId: `${method}:${turn.id}`,
    fingerprint: digest(canonicalJson(envelope)),
  });
}

function sourceMutationEvent(
  sourceEpoch: string,
  sourceSeq: bigint,
  upstreamEventId: string,
  fingerprint: string,
  index: number,
  occurredAtMs: number,
  mutation: RelayAgentSourceMutation,
): Readonly<RelayAgentSourceEvent> {
  return Object.freeze({
    sourceEpoch,
    sourceSeq: sourceSeq.toString(),
    sourceEventId: `codex-${digest(upstreamEventId, fingerprint, String(index))}`,
    occurredAtMs,
    mutation: Object.freeze(mutation),
  });
}

function immutableCorrelation(
  config: Readonly<NormalizedConfig>,
  notification: DecodedNotification,
  item: DecodedUserMessage,
): Readonly<CodexUserMessageCorrelation> {
  return Object.freeze({
    provider: CODEX_APP_SERVER_V2_PROVIDER,
    providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION,
    schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
    sourceEpoch: config.source.sourceEpoch,
    threadId: notification.threadId,
    turnId: notification.turnId,
    itemId: item.id,
    clientId: item.clientId,
  });
}

/**
 * Default-off, process-local trusted-source adapter for one frozen Codex
 * app-server V2 schema. It owns no durable state, route, or capability.
 */
export class CodexAppServerV2EventProducer {
  readonly #enableIngress: (binding: Readonly<RelayAgentTrustedAdapterBinding>) => void;
  readonly #ingestTrustedSource: (
    event: Readonly<RelayAgentSourceEvent>,
  ) => Promise<RelayAgentTrustedIngestResult>;
  readonly #closeIngress: () => Promise<void>;
  #state: ProducerState = "disabled";
  #config: Readonly<NormalizedConfig> | null = null;
  #admitting = false;
  #sourceStarted = false;
  #threadId: string | null = null;
  #activeTurn: ActiveTurn | null = null;
  #nextSourceSeq = 1n;
  #dedupe = new Map<string, DedupeRecord>();
  #queue: QueueJob[] = [];
  #acceptedJobs = 0;
  #draining = false;
  #drainScheduled = false;
  #durableFailed = false;
  #idleWaiters: (() => void)[] = [];
  #leaseClosePromise: Promise<void> | null = null;

  constructor(ingress: RelayAgentTrustedSourceIngressLease) {
    if (
      typeof ingress !== "object"
      || ingress === null
      || nodeTypes.isProxy(ingress)
      || nodeTypes.isProxy(ingress.enable)
      || nodeTypes.isProxy(ingress.ingestTrustedSource)
      || nodeTypes.isProxy(ingress.close)
      || typeof ingress.enable !== "function"
      || typeof ingress.ingestTrustedSource !== "function"
      || typeof ingress.close !== "function"
    ) {
      throw producerError("INVALID_CONFIG");
    }
    this.#enableIngress = ingress.enable.bind(ingress);
    this.#ingestTrustedSource = ingress.ingestTrustedSource.bind(ingress);
    this.#closeIngress = ingress.close.bind(ingress);
  }

  get state(): ProducerState {
    return this.#state;
  }

  get binding(): Readonly<RelayAgentTrustedAdapterBinding> | null {
    return this.#config?.binding ?? null;
  }

  get source(): Readonly<CodexAppServerProducerSource> | null {
    return this.#config?.source ?? null;
  }

  get version(): Readonly<CodexAppServerProducerVersion> | null {
    return this.#config?.version ?? null;
  }

  enable(configInput: unknown): void {
    if (this.#state === "enabled" || this.#state === "enabling") {
      if (this.#state === "enabling") this.#seal("INVALID_CONFIG");
      throw producerError(this.#state === "enabled" ? "ALREADY_ENABLED" : "SEALED");
    }
    if (this.#state === "sealed") throw producerError("SEALED");
    if (this.#state === "closing") throw producerError("CLOSING");
    if (this.#state === "closed") throw producerError("CLOSED");

    this.#state = "enabling";
    try {
      const config = normalizeConfig(configInput);
      if (this.#state !== "enabling") throw producerError("INVALID_CONFIG");
      this.#enableIngress(config.binding);
      if (this.#state !== "enabling") throw producerError("INVALID_CONFIG");
      this.#config = config;
      this.#state = "enabled";
    } catch {
      this.#seal("INVALID_CONFIG");
      throw producerError("INVALID_CONFIG");
    }
  }

  accept(bytesInput: Uint8Array): Promise<Readonly<CodexAppServerProducerResult>> {
    const unavailable = this.#unavailableCode();
    if (unavailable !== null) return Promise.reject(producerError(unavailable));
    if (this.#admitting) {
      this.#seal("INVALID_EVENT");
      return Promise.reject(producerError("SEALED"));
    }

    this.#admitting = true;
    try {
      const config = this.#config!;
      if (
        nodeTypes.isProxy(bytesInput)
        || !(bytesInput instanceof Uint8Array)
        || bytesInput.byteLength > config.limits.maxInputBytes
      ) {
        throw producerError("INVALID_EVENT");
      }
      const notification = decodeNotification(new Uint8Array(bytesInput));
      const retained = this.#dedupe.get(notification.upstreamEventId);
      if (retained !== undefined) {
        if (retained.fingerprint !== notification.fingerprint) {
          throw producerError("INVALID_EVENT");
        }
        return retained.promise.then(() => Object.freeze({
          ...retained.result,
          disposition: "duplicate" as const,
        }));
      }
      if (this.#acceptedJobs >= config.limits.maxPendingEvents) {
        throw producerError("CAPACITY");
      }
      if (this.#dedupe.size >= config.limits.maxRememberedEvents) {
        throw producerError("CAPACITY");
      }

      const events = this.#planUnique(notification);
      if (this.#state !== "enabled") throw producerError("INVALID_EVENT");
      const firstSourceSeq = events[0]!.sourceSeq;
      const result = Object.freeze({
        disposition: "applied" as const,
        upstreamEventId: notification.upstreamEventId,
        firstSourceSeq,
        lastSourceSeq: events[events.length - 1]!.sourceSeq,
        sourceEventCount: events.length,
      });
      const completion = deferred<Readonly<CodexAppServerProducerResult>>();
      const job: QueueJob = { result, events, deferred: completion };
      this.#dedupe.set(notification.upstreamEventId, {
        fingerprint: notification.fingerprint,
        result,
        promise: completion.promise,
      });
      this.#queue.push(job);
      this.#acceptedJobs += 1;
      this.#scheduleDrain();
      return completion.promise;
    } catch (error) {
      const code = error instanceof CodexAppServerProducerError && error.code === "CAPACITY"
        ? "CAPACITY"
        : "INVALID_EVENT";
      this.#seal(code);
      return Promise.reject(producerError(code));
    } finally {
      this.#admitting = false;
    }
  }

  close(): Promise<void> {
    if (this.#state === "closed") return this.#leaseClosePromise ?? Promise.resolve();
    if (this.#state === "sealed") return this.#ensureLeaseClose(false);
    if (this.#state === "closing") return this.#ensureLeaseClose(true);
    this.#state = "closing";
    return this.#ensureLeaseClose(true);
  }

  #unavailableCode(): CodexAppServerProducerErrorCode | null {
    if (this.#state === "disabled") return "DISABLED";
    if (this.#state === "enabling" || this.#state === "sealed") return "SEALED";
    if (this.#state === "closing") return "CLOSING";
    if (this.#state === "closed") return "CLOSED";
    return null;
  }

  #planUnique(notification: DecodedNotification): readonly Readonly<RelayAgentSourceEvent>[] {
    const config = this.#config!;
    if (this.#threadId !== null && notification.threadId !== this.#threadId) {
      throw producerError("INVALID_EVENT");
    }

    const mutations: RelayAgentSourceMutation[] = [];
    if (notification.method === "turn/started") {
      const turn = notification.turn!;
      if (
        this.#activeTurn !== null
        || turn.status !== "inProgress"
        || turn.error !== null
        || turn.itemsView !== "full"
        || turn.items.length !== 0
        || turn.startedAt === null
        || turn.completedAt !== null
        || turn.durationMs !== null
      ) {
        throw producerError("INVALID_EVENT");
      }
      const runId = `codex-run-${digest(config.source.sourceEpoch, notification.threadId, turn.id)}`;
      const extensionTurnId = `codex-turn-${digest(config.source.sourceEpoch, notification.threadId, turn.id)}`;
      if (!this.#sourceStarted) mutations.push({ mutationType: "source.started" });
      mutations.push({
        mutationType: "lifecycle.changed",
        scope: "run",
        runId,
        turnId: null,
        state: "running",
        failure: null,
      });
      mutations.push({
        mutationType: "lifecycle.changed",
        scope: "turn",
        runId,
        turnId: extensionTurnId,
        state: "running",
        failure: null,
      });
      this.#sourceStarted = true;
      this.#threadId = notification.threadId;
      this.#activeTurn = {
        threadId: notification.threadId,
        upstreamTurnId: turn.id,
        runId,
        turnId: extensionTurnId,
        observedItemIds: new Set(),
      };
    } else if (notification.method === "item/completed") {
      const active = this.#activeTurn;
      const item = notification.item!;
      if (
        active === null
        || notification.threadId !== active.threadId
        || notification.turnId !== active.upstreamTurnId
        || active.observedItemIds.has(item.id)
      ) {
        throw producerError("INVALID_EVENT");
      }
      let commandId: string | null = null;
      if (item.type === "userMessage" && config.correlate !== null) {
        let correlated: string | null;
        try {
          correlated = config.correlate(immutableCorrelation(config, notification, item));
        } catch {
          throw producerError("INVALID_EVENT");
        }
        if (this.#state !== "enabled" || this.#admitting !== true) {
          throw producerError("INVALID_EVENT");
        }
        commandId = correlated === null ? null : opaqueId(correlated, "INVALID_EVENT");
      }
      mutations.push({
        mutationType: "text_entry.appended",
        entryId: `codex-entry-${digest(config.source.sourceEpoch, active.upstreamTurnId, item.id)}`,
        runId: active.runId,
        turnId: active.turnId,
        role: item.type === "userMessage" ? "user" : "agent",
        text: item.text,
        commandId: item.type === "userMessage" ? commandId : null,
      });
      active.observedItemIds.add(item.id);
    } else {
      const active = this.#activeTurn;
      const turn = notification.turn!;
      if (
        active === null
        || notification.threadId !== active.threadId
        || turn.id !== active.upstreamTurnId
        || turn.itemsView !== "full"
        || turn.startedAt === null
        || turn.completedAt === null
        || turn.durationMs === null
        || (turn.status !== "completed" && turn.status !== "failed")
        || (turn.status === "completed" && turn.error !== null)
        || (turn.status === "failed" && turn.error === null)
        || turn.items.length !== 0
      ) {
        throw producerError("INVALID_EVENT");
      }
      const failure = turn.status === "failed"
        ? Object.freeze({ code: "codex_turn_failed", summary: null })
        : null;
      mutations.push({
        mutationType: "lifecycle.changed",
        scope: "turn",
        runId: active.runId,
        turnId: active.turnId,
        state: turn.status,
        failure,
      });
      mutations.push({
        mutationType: "lifecycle.changed",
        scope: "run",
        runId: active.runId,
        turnId: null,
        state: turn.status,
        failure,
      });
      this.#activeTurn = null;
    }

    const first = this.#nextSourceSeq;
    const events = mutations.map((mutation, index) => sourceMutationEvent(
      config.source.sourceEpoch,
      first + BigInt(index),
      notification.upstreamEventId,
      notification.fingerprint,
      index,
      notification.occurredAtMs,
      mutation,
    ));
    this.#nextSourceSeq += BigInt(events.length);
    return Object.freeze(events);
  }

  #scheduleDrain(): void {
    if (this.#draining || this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const job = this.#queue.shift()!;
        if (this.#durableFailed) {
          this.#acceptedJobs -= 1;
          job.deferred.reject(producerError("DURABLE_REJECTED"));
          continue;
        }
        try {
          for (const event of job.events) {
            const result: RelayAgentTrustedIngestResult = await this.#ingestTrustedSource(event);
            if (result.reduction.disposition !== "applied") {
              throw producerError("DURABLE_REJECTED");
            }
          }
          job.deferred.resolve(job.result);
        } catch {
          this.#durableFailed = true;
          this.#seal("DURABLE_REJECTED");
          job.deferred.reject(producerError("DURABLE_REJECTED"));
        } finally {
          this.#acceptedJobs -= 1;
        }
      }
    } finally {
      this.#draining = false;
      const waiters = this.#idleWaiters.splice(0);
      for (const settle of waiters) settle();
    }
  }

  #waitForIdle(): Promise<void> {
    if (!this.#draining && this.#queue.length === 0 && !this.#drainScheduled) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  #ensureLeaseClose(markClosed: boolean): Promise<void> {
    if (this.#leaseClosePromise === null) {
      this.#leaseClosePromise = (async () => {
        await this.#waitForIdle();
        await this.#closeIngress();
      })();
    }
    if (!markClosed) return this.#leaseClosePromise;
    return this.#leaseClosePromise.then(() => {
      if (this.#state === "closing") this.#state = "closed";
    });
  }

  #seal(_code: "INVALID_CONFIG" | "INVALID_EVENT" | "CAPACITY" | "DURABLE_REJECTED"): void {
    if (this.#state === "closed" || this.#state === "sealed") return;
    this.#state = "sealed";
    void this.#ensureLeaseClose(false);
  }
}
