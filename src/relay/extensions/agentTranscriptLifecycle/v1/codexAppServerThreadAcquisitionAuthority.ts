import { isAbsolute, normalize } from "node:path";
import { types as nodeTypes } from "node:util";

export const CODEX_APP_SERVER_THREAD_ACQUISITION_PROVIDER_VERSION = "0.146.0" as const;

/**
 * Evidence generated with the exact official 0.146.0 executable using:
 *
 *   codex app-server generate-json-schema --out <private-directory>
 *
 * The raw file has nondeterministic JSON object-key order. `sha256` therefore
 * covers its compact JSON form with every object key sorted lexicographically
 * (equivalent to `jq -S -c .`, including its trailing LF), while `byteLength`
 * covers the raw generated file. A controller must generate and canonicalize
 * that file from the same captured executable identity it uses for the
 * initialized stdio channel; this module never consults PATH.
 */
export const CODEX_APP_SERVER_0_146_0_THREAD_SCHEMA_EVIDENCE = Object.freeze({
  relativePath: "codex_app_server_protocol.v2.schemas.json",
  byteLength: 498_467,
  sha256: "2f402b7d1356adccc1a4785c0656db457578ca9ea5d5b08953487a410c630ce8",
});

const MAX_RESPONSE_BYTES = 131_072;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_KEYS = 8_192;
const MAX_JSON_NODES = 16_384;
const MAX_JSON_ARRAY_LENGTH = 4_096;
const MAX_ID_BYTES = 128;
const MAX_PATH_BYTES = 4_096;
const EXCHANGE_TIMEOUT_MS = 5_000;
const THREAD_LIST_REQUEST_ID = 2;
const THREAD_RESUME_REQUEST_ID = 3;

const THREAD_REQUIRED_KEYS = Object.freeze([
  "cliVersion",
  "createdAt",
  "cwd",
  "ephemeral",
  "id",
  "modelProvider",
  "preview",
  "sessionId",
  "source",
  "status",
  "turns",
  "updatedAt",
]);
const RESUME_REQUIRED_KEYS = Object.freeze([
  "approvalPolicy",
  "approvalsReviewer",
  "cwd",
  "model",
  "modelProvider",
  "sandbox",
  "thread",
]);
export type CodexAppServerThreadAcquisitionState =
  | "disabled"
  | "acquiring"
  | "acquired"
  | "sealed";

export type CodexAppServerThreadAcquisitionErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_SCHEMA_EVIDENCE"
  | "INVALID_SELECTION"
  | "ACQUISITION_IN_PROGRESS"
  | "ALREADY_ACQUIRED"
  | "CHANNEL_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_MISMATCH"
  | "THREAD_NOT_UNIQUE"
  | "THREAD_BINDING_MISMATCH"
  | "OWNERSHIP_HANDOFF_FAILED"
  | "SEALED";

const ERROR_MESSAGES: Readonly<Record<CodexAppServerThreadAcquisitionErrorCode, string>> =
  Object.freeze({
    INVALID_OPTIONS: "Codex thread acquisition options are invalid",
    INVALID_SCHEMA_EVIDENCE: "Codex app-server schema evidence is invalid",
    INVALID_SELECTION: "Codex thread selection is invalid",
    ACQUISITION_IN_PROGRESS: "Codex thread acquisition is already in progress",
    ALREADY_ACQUIRED: "Codex thread was already acquired",
    CHANNEL_FAILED: "Codex app-server request channel failed",
    RESPONSE_TOO_LARGE: "Codex app-server response exceeded its bound",
    RESPONSE_MISMATCH: "Codex app-server response did not match the exact protocol exchange",
    THREAD_NOT_UNIQUE: "Codex thread discovery did not resolve exactly one thread",
    THREAD_BINDING_MISMATCH: "Codex thread did not match the trusted selection",
    OWNERSHIP_HANDOFF_FAILED: "Codex thread external ownership handoff failed",
    SEALED: "Codex thread acquisition authority is sealed",
  });

export class CodexAppServerThreadAcquisitionError extends Error {
  constructor(readonly code: CodexAppServerThreadAcquisitionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexAppServerThreadAcquisitionError";
  }
}

export interface CodexAppServerThreadProtocolSchemaDigest {
  readonly providerVersion: typeof CODEX_APP_SERVER_THREAD_ACQUISITION_PROVIDER_VERSION;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

declare const CODEX_APP_SERVER_THREAD_SCHEMA_EVIDENCE_BRAND: unique symbol;
export interface CodexAppServerThreadProtocolSchemaEvidence {
  readonly [CODEX_APP_SERVER_THREAD_SCHEMA_EVIDENCE_BRAND]: true;
}

export interface CodexAppServerThreadJsonRpcRequest {
  readonly id: number;
  readonly method: "thread/list" | "thread/resume";
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Exclusive initialized JSON-RPC channel. The channel owner must correlate the
 * exact request id while continuing to route unrelated server notifications.
 */
export interface CodexAppServerThreadRequestChannel {
  exchange(
    request: Readonly<CodexAppServerThreadJsonRpcRequest>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface CodexAppServerThreadSelection {
  readonly threadId: string;
  readonly cwd: string;
}

export interface CodexAppServerThreadOwnershipCandidate {
  readonly threadId: string;
  readonly cwd: string;
  readonly rolloutPath: string;
  readonly source: "cli";
}

export interface CodexAppServerThreadOwnershipReceipt
extends CodexAppServerThreadOwnershipCandidate {
  readonly disposition: "exclusive";
}

/**
 * This port is the mandatory boundary outside app-server. `notLoaded` only
 * describes this app-server process and is not proof that the original CLI is
 * stopped. The injected owner must stop/drain or transfer that external CLI
 * before returning the exact receipt. Resume is never attempted first.
 */
export interface CodexAppServerThreadOwnershipHandoffPort {
  takeExclusiveOwnership(
    candidate: Readonly<CodexAppServerThreadOwnershipCandidate>,
    signal: AbortSignal,
  ): Promise<Readonly<CodexAppServerThreadOwnershipReceipt>>;
}

export interface CodexAppServerThreadAcquisitionAuthorityOptions {
  readonly executableIdentity: object;
  readonly schemaEvidence: CodexAppServerThreadProtocolSchemaEvidence;
  readonly channel: CodexAppServerThreadRequestChannel;
  readonly ownershipHandoff: CodexAppServerThreadOwnershipHandoffPort;
}

export interface CodexAppServerAcquiredThreadSubscription {
  readonly providerVersion: typeof CODEX_APP_SERVER_THREAD_ACQUISITION_PROVIDER_VERSION;
  readonly threadId: string;
  readonly cwd: string;
  readonly rolloutPath: string;
  readonly source: "cli";
  readonly subscription: "resumed";
}

interface NormalizedChannel {
  exchange(request: Readonly<CodexAppServerThreadJsonRpcRequest>, signal: AbortSignal): unknown;
}

interface NormalizedHandoff {
  takeExclusiveOwnership(
    candidate: Readonly<CodexAppServerThreadOwnershipCandidate>,
    signal: AbortSignal,
  ): unknown;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const schemaEvidenceRecords = new WeakMap<object, object>();
const claimedChannels = new WeakSet<object>();

function acquisitionError(
  code: CodexAppServerThreadAcquisitionErrorCode,
): CodexAppServerThreadAcquisitionError {
  return new CodexAppServerThreadAcquisitionError(code);
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
        || nodeTypes.isProxy(descriptor.value)) return null;
      return descriptor.value;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function exactFrozenDataObject(
  value: unknown,
  keys: readonly string[],
  code: CodexAppServerThreadAcquisitionErrorCode,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || !isPlainObject(value)
    || !Object.isFrozen(value)) throw acquisitionError(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw acquisitionError(code);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || descriptor.configurable
      || descriptor.writable) throw acquisitionError(code);
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function boundedString(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || !isWellFormedUnicode(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw acquisitionError("THREAD_BINDING_MISMATCH");
  }
  return value;
}

function exactAbsolutePath(value: unknown): string {
  const path = boundedString(value, MAX_PATH_BYTES);
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw acquisitionError("THREAD_BINDING_MISMATCH");
  }
  return path;
}

function exactThreadId(value: unknown): string {
  const threadId = boundedString(value, MAX_ID_BYTES);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(threadId)) {
    throw acquisitionError("THREAD_BINDING_MISMATCH");
  }
  return threadId;
}

function normalizeSelection(value: unknown): Readonly<CodexAppServerThreadSelection> {
  let fields: Readonly<Record<string, unknown>>;
  try {
    fields = exactFrozenDataObject(value, ["threadId", "cwd"], "INVALID_SELECTION");
    return Object.freeze({
      threadId: exactThreadId(fields.threadId),
      cwd: exactAbsolutePath(fields.cwd),
    });
  } catch (error) {
    if (error instanceof CodexAppServerThreadAcquisitionError
      && error.code === "INVALID_SELECTION") throw error;
    throw acquisitionError("INVALID_SELECTION");
  }
}

function normalizeJson(value: unknown): JsonValue {
  let nodes = 0;
  let keys = 0;
  const visit = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw acquisitionError("RESPONSE_TOO_LARGE");
    }
    if (current === null || typeof current === "boolean" || typeof current === "string") {
      if (typeof current === "string"
        && (!isWellFormedUnicode(current)
          || Buffer.byteLength(current, "utf8") > MAX_RESPONSE_BYTES)) {
        throw acquisitionError("RESPONSE_TOO_LARGE");
      }
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw acquisitionError("RESPONSE_MISMATCH");
      return current;
    }
    if (typeof current !== "object" || nodeTypes.isProxy(current)) {
      throw acquisitionError("RESPONSE_MISMATCH");
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_JSON_ARRAY_LENGTH) throw acquisitionError("RESPONSE_TOO_LARGE");
      return current.map((entry) => visit(entry, depth + 1));
    }
    if (!isPlainObject(current)) throw acquisitionError("RESPONSE_MISMATCH");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Reflect.ownKeys(descriptors);
    keys += ownKeys.length;
    if (keys > MAX_JSON_KEYS) throw acquisitionError("RESPONSE_TOO_LARGE");
    const result: { [key: string]: JsonValue } = Object.create(null) as {
      [key: string]: JsonValue;
    };
    for (const key of ownKeys) {
      if (typeof key !== "string") throw acquisitionError("RESPONSE_MISMATCH");
      const descriptor = descriptors[key];
      if (descriptor === undefined
        || !("value" in descriptor)
        || !descriptor.enumerable) throw acquisitionError("RESPONSE_MISMATCH");
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const normalized = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_RESPONSE_BYTES) {
    throw acquisitionError("RESPONSE_TOO_LARGE");
  }
  return normalized;
}

function requiredJsonObject(
  value: JsonValue,
  requiredKeys: readonly string[],
): { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw acquisitionError("RESPONSE_MISMATCH");
  }
  const actual = Object.keys(value);
  if (requiredKeys.some((key) => !actual.includes(key))) {
    throw acquisitionError("RESPONSE_MISMATCH");
  }
  return value;
}

function validateEnvelope(value: unknown, expectedId: number): { [key: string]: JsonValue } {
  const envelope = requiredJsonObject(normalizeJson(value), ["id", "result"]);
  if (envelope.id !== expectedId) throw acquisitionError("RESPONSE_MISMATCH");
  return requiredJsonObject(envelope.result, []);
}

interface ValidatedThread {
  readonly rolloutPath: string;
  readonly modelProvider: string;
}

function validateThread(
  value: JsonValue,
  selection: Readonly<CodexAppServerThreadSelection>,
  expectedStatus: "notLoaded" | "idle",
  expectedRolloutPath: string | null,
): Readonly<ValidatedThread> {
  const thread = requiredJsonObject(value, THREAD_REQUIRED_KEYS);
  let threadId: string;
  let cwd: string;
  let rolloutPath: string;
  try {
    threadId = exactThreadId(thread.id);
    cwd = exactAbsolutePath(thread.cwd);
    rolloutPath = exactAbsolutePath(thread.path);
  } catch {
    throw acquisitionError("THREAD_BINDING_MISMATCH");
  }
  const status = requiredJsonObject(thread.status, ["type"]);
  if (threadId !== selection.threadId
    || cwd !== selection.cwd
    || thread.source !== "cli"
    || thread.sessionId !== threadId
    || thread.ephemeral !== false
    || status.type !== expectedStatus
    || !Array.isArray(thread.turns)
    || (expectedStatus === "notLoaded" && thread.turns.length !== 0)
    || (expectedRolloutPath !== null && rolloutPath !== expectedRolloutPath)
    || typeof thread.modelProvider !== "string"
    || thread.modelProvider.length === 0
    || typeof thread.cliVersion !== "string"
    || thread.cliVersion.length === 0
    || typeof thread.preview !== "string"
    || !Number.isSafeInteger(thread.createdAt)
    || !Number.isSafeInteger(thread.updatedAt)) {
    throw acquisitionError("THREAD_BINDING_MISMATCH");
  }
  return Object.freeze({ rolloutPath, modelProvider: thread.modelProvider });
}

function normalizeChannel(value: unknown): Readonly<NormalizedChannel> {
  if (typeof value !== "object"
    || value === null
    || nodeTypes.isProxy(value)
    || claimedChannels.has(value)) throw acquisitionError("INVALID_OPTIONS");
  const exchange = dataMethod(value, "exchange");
  if (exchange === null) throw acquisitionError("INVALID_OPTIONS");
  claimedChannels.add(value);
  return Object.freeze({
    exchange: (
      request: Readonly<CodexAppServerThreadJsonRpcRequest>,
      signal: AbortSignal,
    ) => exchange.call(value, request, signal),
  });
}

function normalizeHandoff(value: unknown): Readonly<NormalizedHandoff> {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw acquisitionError("INVALID_OPTIONS");
  }
  const takeExclusiveOwnership = dataMethod(value, "takeExclusiveOwnership");
  if (takeExclusiveOwnership === null) throw acquisitionError("INVALID_OPTIONS");
  return Object.freeze({
    takeExclusiveOwnership: (
      candidate: Readonly<CodexAppServerThreadOwnershipCandidate>,
      signal: AbortSignal,
    ) => takeExclusiveOwnership.call(value, candidate, signal),
  });
}

function requireNativePromise(value: unknown, code: CodexAppServerThreadAcquisitionErrorCode): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) throw acquisitionError(code);
  return value as Promise<unknown>;
}

async function boundedOperation(
  start: (signal: AbortSignal) => unknown,
  code: "CHANNEL_FAILED" | "OWNERSHIP_HANDOFF_FAILED",
): Promise<unknown> {
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abort.abort();
      reject(acquisitionError(code));
    }, EXCHANGE_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const operation = requireNativePromise(start(abort.signal), code);
    void operation.catch(() => undefined);
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (error instanceof CodexAppServerThreadAcquisitionError) throw error;
    throw acquisitionError(code);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    abort.abort();
  }
}

function exactOwnershipReceipt(
  value: unknown,
  candidate: Readonly<CodexAppServerThreadOwnershipCandidate>,
): void {
  let receipt: Readonly<Record<string, unknown>>;
  try {
    receipt = exactFrozenDataObject(
      value,
      ["threadId", "cwd", "rolloutPath", "source", "disposition"],
      "OWNERSHIP_HANDOFF_FAILED",
    );
  } catch {
    throw acquisitionError("OWNERSHIP_HANDOFF_FAILED");
  }
  if (receipt.threadId !== candidate.threadId
    || receipt.cwd !== candidate.cwd
    || receipt.rolloutPath !== candidate.rolloutPath
    || receipt.source !== "cli"
    || receipt.disposition !== "exclusive") {
    throw acquisitionError("OWNERSHIP_HANDOFF_FAILED");
  }
}

/**
 * Binds generated schema evidence to the opaque executable artifact identity.
 * The caller owns the actual bounded schema-generation subprocess and digest;
 * this capture only admits the exact official 0.146.0 bundle fingerprint.
 */
export function captureCodexAppServerThreadProtocolSchemaEvidence(
  executableIdentity: object,
  digest: Readonly<CodexAppServerThreadProtocolSchemaDigest>,
): CodexAppServerThreadProtocolSchemaEvidence {
  if (typeof executableIdentity !== "object"
    || executableIdentity === null
    || nodeTypes.isProxy(executableIdentity)
    || !Object.isFrozen(executableIdentity)) {
    throw acquisitionError("INVALID_SCHEMA_EVIDENCE");
  }
  const fields = exactFrozenDataObject(digest, [
    "providerVersion",
    "relativePath",
    "byteLength",
    "sha256",
  ], "INVALID_SCHEMA_EVIDENCE");
  const expected = CODEX_APP_SERVER_0_146_0_THREAD_SCHEMA_EVIDENCE;
  if (fields.providerVersion !== CODEX_APP_SERVER_THREAD_ACQUISITION_PROVIDER_VERSION
    || fields.relativePath !== expected.relativePath
    || fields.byteLength !== expected.byteLength
    || fields.sha256 !== expected.sha256) {
    throw acquisitionError("INVALID_SCHEMA_EVIDENCE");
  }
  const evidence = Object.freeze(Object.create(null)) as CodexAppServerThreadProtocolSchemaEvidence;
  schemaEvidenceRecords.set(evidence, executableIdentity);
  return evidence;
}

/**
 * Default-off one-shot acquisition usable after app-server initialize. It
 * proves a unique durable CLI record using structured list data, waits for an
 * injected external-owner handoff, and only then resumes/subscribes on this
 * app-server channel. It never derives identity or lifecycle from terminal
 * text and never claims that `notLoaded` means the CLI process is stopped.
 */
export class CodexAppServerThreadAcquisitionAuthority {
  readonly #channel: Readonly<NormalizedChannel>;
  readonly #handoff: Readonly<NormalizedHandoff>;
  #state: CodexAppServerThreadAcquisitionState = "disabled";
  #failure: CodexAppServerThreadAcquisitionErrorCode | null = null;

  constructor(options: Readonly<CodexAppServerThreadAcquisitionAuthorityOptions>) {
    let fields: Readonly<Record<string, unknown>>;
    try {
      fields = exactFrozenDataObject(options, [
        "executableIdentity",
        "schemaEvidence",
        "channel",
        "ownershipHandoff",
      ], "INVALID_OPTIONS");
    } catch {
      throw acquisitionError("INVALID_OPTIONS");
    }
    if (typeof fields.executableIdentity !== "object"
      || fields.executableIdentity === null
      || nodeTypes.isProxy(fields.executableIdentity)
      || schemaEvidenceRecords.get(fields.schemaEvidence as object) !== fields.executableIdentity) {
      throw acquisitionError("INVALID_SCHEMA_EVIDENCE");
    }
    this.#channel = normalizeChannel(fields.channel);
    this.#handoff = normalizeHandoff(fields.ownershipHandoff);
  }

  get state(): CodexAppServerThreadAcquisitionState {
    return this.#state;
  }

  get failure(): CodexAppServerThreadAcquisitionErrorCode | null {
    return this.#failure;
  }

  async acquire(
    selectionInput: Readonly<CodexAppServerThreadSelection>,
  ): Promise<Readonly<CodexAppServerAcquiredThreadSubscription>> {
    if (arguments.length !== 1) throw acquisitionError("INVALID_SELECTION");
    if (this.#state !== "disabled") {
      throw acquisitionError(
        this.#state === "acquiring" ? "ACQUISITION_IN_PROGRESS"
          : this.#state === "acquired" ? "ALREADY_ACQUIRED"
            : "SEALED",
      );
    }
    const selection = normalizeSelection(selectionInput);
    this.#state = "acquiring";
    try {
      const listRequest = Object.freeze({
        id: THREAD_LIST_REQUEST_ID,
        method: "thread/list" as const,
        params: Object.freeze({
          archived: false,
          cursor: null,
          cwd: selection.cwd,
          limit: 2,
          sourceKinds: Object.freeze(["cli"]),
        }),
      });
      const listResponse = validateEnvelope(
        await boundedOperation(
          (signal) => this.#channel.exchange(listRequest, signal),
          "CHANNEL_FAILED",
        ),
        THREAD_LIST_REQUEST_ID,
      );
      const listResult = requiredJsonObject(
        listResponse,
        ["data", "nextCursor"],
      );
      if (!Array.isArray(listResult.data)
        || listResult.data.length !== 1
        || listResult.nextCursor !== null) {
        throw acquisitionError("THREAD_NOT_UNIQUE");
      }
      const listed = validateThread(listResult.data[0], selection, "notLoaded", null);
      const candidate = Object.freeze({
        threadId: selection.threadId,
        cwd: selection.cwd,
        rolloutPath: listed.rolloutPath,
        source: "cli" as const,
      });
      const ownershipReceipt = await boundedOperation(
        (signal) => this.#handoff.takeExclusiveOwnership(candidate, signal),
        "OWNERSHIP_HANDOFF_FAILED",
      );
      exactOwnershipReceipt(ownershipReceipt, candidate);

      const resumeRequest = Object.freeze({
        id: THREAD_RESUME_REQUEST_ID,
        method: "thread/resume" as const,
        params: Object.freeze({ cwd: selection.cwd, threadId: selection.threadId }),
      });
      const resumeResponse = validateEnvelope(
        await boundedOperation(
          (signal) => this.#channel.exchange(resumeRequest, signal),
          "CHANNEL_FAILED",
        ),
        THREAD_RESUME_REQUEST_ID,
      );
      const resumeResult = requiredJsonObject(
        resumeResponse,
        RESUME_REQUIRED_KEYS,
      );
      const resumed = validateThread(
        resumeResult.thread,
        selection,
        "idle",
        listed.rolloutPath,
      );
      if (resumeResult.cwd !== selection.cwd
        || typeof resumeResult.model !== "string"
        || resumeResult.model.length === 0
        || resumeResult.modelProvider !== resumed.modelProvider) {
        throw acquisitionError("THREAD_BINDING_MISMATCH");
      }
      this.#state = "acquired";
      return Object.freeze({
        providerVersion: CODEX_APP_SERVER_THREAD_ACQUISITION_PROVIDER_VERSION,
        threadId: selection.threadId,
        cwd: selection.cwd,
        rolloutPath: listed.rolloutPath,
        source: "cli" as const,
        subscription: "resumed" as const,
      });
    } catch (error) {
      const normalized = error instanceof CodexAppServerThreadAcquisitionError
        ? error
        : acquisitionError("RESPONSE_MISMATCH");
      this.#failure = normalized.code;
      this.#state = "sealed";
      throw normalized;
    }
  }
}
