import { createHash, timingSafeEqual } from "node:crypto";
import {
  constants as fsConstants,
  promises as fsPromises,
  type FileHandle,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { types as nodeTypes } from "node:util";

import {
  CODEX_APP_SERVER_V2_PROVIDER,
  CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0,
  CODEX_APP_SERVER_V2_SCHEMA_VERSION,
} from "../extensions/agentTranscriptLifecycle/v1/codexAppServerProducer.js";
import type {
  CodexAppServerControlledProcess,
  CodexAppServerProcessControllerPort,
} from "../extensions/agentTranscriptLifecycle/v1/codexAppServerProcessControllerAuthority.js";
import type { CodexAppServerNotificationByteSource } from
  "../extensions/agentTranscriptLifecycle/v1/codexAppServerNotificationSource.js";
import type {
  RelayV2CanonicalResolvedSessionTarget,
  RelayV2CanonicalResourceResolverPort,
} from "./resourceState.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonObject,
} from "./strictJson.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_JSONL_FRAME_BYTES = 131_072;
const INITIALIZE_TIMEOUT_MS = 5_000;
const TERMINATE_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 2_000;
const CLIENT_NAME = "tmux-worktree-relay-host";
const CLIENT_TITLE = "tmux-worktree Relay Host";
const CLIENT_VERSION = "1";
const JSON_LIMITS = Object.freeze({
  maxDepth: 24,
  maxDirectKeys: 32,
  maxTotalKeys: 8_192,
  maxNodes: 16_384,
});
const ACCEPTED_NOTIFICATION_METHODS = new Set([
  "turn/started",
  "item/completed",
  "turn/completed",
]);

export type RelayV2HostCodexAppServerProcessControllerErrorCode =
  | "INVALID_OPTIONS"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_MISMATCH"
  | "H2_BINDING_MISMATCH"
  | "ALREADY_CLAIMED"
  | "SPAWN_FAILED"
  | "HANDSHAKE_FAILED"
  | "SOURCE_FAILED"
  | "PROCESS_DRAIN_FAILED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostCodexAppServerProcessControllerErrorCode,
string
>> = Object.freeze({
  INVALID_OPTIONS: "Codex app-server process controller options are invalid",
  ARTIFACT_UNAVAILABLE: "Codex app-server executable artifact is unavailable",
  ARTIFACT_MISMATCH: "Codex app-server executable artifact identity changed",
  H2_BINDING_MISMATCH: "Codex app-server target does not match current H2 evidence",
  ALREADY_CLAIMED: "Codex app-server process controller was already claimed",
  SPAWN_FAILED: "Codex app-server process could not be spawned",
  HANDSHAKE_FAILED: "Codex app-server handshake did not match the exact version lane",
  SOURCE_FAILED: "Codex app-server structured notification source failed",
  PROCESS_DRAIN_FAILED: "Codex app-server process could not be reaped",
});

export class RelayV2HostCodexAppServerProcessControllerError extends Error {
  constructor(readonly code: RelayV2HostCodexAppServerProcessControllerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostCodexAppServerProcessControllerError";
  }
}

declare const RELAY_V2_HOST_CODEX_EXECUTABLE_ARTIFACT_BRAND: unique symbol;
export interface RelayV2HostCodexAppServerExecutableArtifact {
  readonly [RELAY_V2_HOST_CODEX_EXECUTABLE_ARTIFACT_BRAND]: true;
}

export interface RelayV2HostCodexAppServerExecutableArtifactInput {
  readonly executablePath: string;
  readonly sha256: string;
  readonly provider: typeof CODEX_APP_SERVER_V2_PROVIDER;
  readonly providerVersion: typeof CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0;
  readonly schemaVersion: typeof CODEX_APP_SERVER_V2_SCHEMA_VERSION;
}

export interface RelayV2HostCodexAppServerStructuredNotificationProcessOptions {
  readonly executableArtifact: RelayV2HostCodexAppServerExecutableArtifact;
  readonly scopeId: string;
  readonly sessionId: string;
}

interface ArtifactRecord {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
}

interface CapturedControllerOptions {
  readonly artifact: Readonly<ArtifactRecord>;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly scopeId: string;
  readonly sessionId: string;
  readonly resolver: RelayV2CanonicalResourceResolverPort;
}

interface LineResult {
  readonly bytes: Uint8Array;
  readonly object: RelayV2JsonObject;
}

const executableArtifacts = new WeakMap<object, Readonly<ArtifactRecord>>();

function controllerError(
  code: RelayV2HostCodexAppServerProcessControllerErrorCode,
): RelayV2HostCodexAppServerProcessControllerError {
  return new RelayV2HostCodexAppServerProcessControllerError(code);
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
    throw controllerError("INVALID_OPTIONS");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw controllerError("INVALID_OPTIONS");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
      || (requireFrozen && (descriptor.configurable || descriptor.writable))) {
      throw controllerError("INVALID_OPTIONS");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
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

function opaque(value: unknown, maximumBytes = 4_096): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || !isWellFormedUnicode(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw controllerError("INVALID_OPTIONS");
  }
  return value;
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw controllerError("INVALID_OPTIONS");
  }
  return value;
}

function sameDigest(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function inspectOpenExecutable(
  handle: FileHandle,
  expectedSha256: string,
): Promise<Readonly<ArtifactRecord>> {
  const stat = await handle.stat({ bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (!stat.isFile()
    || stat.nlink !== 1n
    || stat.size < 1n
    || stat.size > BigInt(MAX_EXECUTABLE_BYTES)
    || (stat.mode & 0o111n) === 0n
    || (currentUid !== null && stat.uid !== currentUid && stat.uid !== 0n)) {
    throw controllerError("ARTIFACT_UNAVAILABLE");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < Number(stat.size)) {
    const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(stat.size) - offset), offset);
    if (read.bytesRead < 1) throw controllerError("ARTIFACT_UNAVAILABLE");
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  const digest = hash.digest("hex");
  if (!sameDigest(digest, expectedSha256)) throw controllerError("ARTIFACT_MISMATCH");
  return Object.freeze({
    canonicalPath: "",
    sha256: digest,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
  });
}

async function inspectExecutable(
  canonicalPath: string,
  expectedSha256: string,
): Promise<Readonly<ArtifactRecord>> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const inspected = await inspectOpenExecutable(handle, expectedSha256);
    return Object.freeze({ ...inspected, canonicalPath });
  } catch (error) {
    if (error instanceof RelayV2HostCodexAppServerProcessControllerError) throw error;
    throw controllerError("ARTIFACT_UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameArtifact(
  expected: Readonly<ArtifactRecord>,
  actual: Readonly<ArtifactRecord>,
): boolean {
  return expected.canonicalPath === actual.canonicalPath
    && sameDigest(expected.sha256, actual.sha256)
    && expected.device === actual.device
    && expected.inode === actual.inode
    && expected.size === actual.size
    && expected.modifiedAtNs === actual.modifiedAtNs;
}

/**
 * Captures one exact privileged executable artifact. The caller supplies the
 * release digest and exact provider/version/schema tuple; no PATH or default
 * executable is consulted.
 */
export async function captureRelayV2HostCodexAppServerExecutableArtifact(
  input: RelayV2HostCodexAppServerExecutableArtifactInput,
): Promise<RelayV2HostCodexAppServerExecutableArtifact> {
  const fields = exactDataObject(
    input,
    ["executablePath", "sha256", "provider", "providerVersion", "schemaVersion"],
    true,
  );
  if (fields.provider !== CODEX_APP_SERVER_V2_PROVIDER
    || fields.providerVersion !== CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0
    || fields.schemaVersion !== CODEX_APP_SERVER_V2_SCHEMA_VERSION
    || typeof fields.executablePath !== "string"
    || !isAbsolute(fields.executablePath)
    || normalize(fields.executablePath) !== fields.executablePath) {
    throw controllerError("INVALID_OPTIONS");
  }
  const expectedSha256 = exactSha256(fields.sha256);
  let canonicalPath: string;
  try {
    canonicalPath = await fsPromises.realpath(fields.executablePath);
  } catch {
    throw controllerError("ARTIFACT_UNAVAILABLE");
  }
  if (!isAbsolute(canonicalPath) || normalize(canonicalPath) !== canonicalPath) {
    throw controllerError("ARTIFACT_UNAVAILABLE");
  }
  const record = await inspectExecutable(canonicalPath, expectedSha256);
  const artifact = Object.freeze(Object.create(null)) as RelayV2HostCodexAppServerExecutableArtifact;
  executableArtifacts.set(artifact, record);
  return artifact;
}

class BoundedJsonLineReader {
  readonly #iterator: AsyncIterator<unknown>;
  #buffer = Buffer.alloc(0);
  #ended = false;

  constructor(stdout: NodeJS.ReadableStream) {
    const iteratorFactory = stdout[Symbol.asyncIterator];
    if (typeof iteratorFactory !== "function" || nodeTypes.isProxy(iteratorFactory)) {
      throw controllerError("SPAWN_FAILED");
    }
    this.#iterator = iteratorFactory.call(stdout) as AsyncIterator<unknown>;
  }

  async next(): Promise<LineResult | null> {
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline >= 0) {
        if (newline < 1 || newline > MAX_JSONL_FRAME_BYTES) {
          throw controllerError("SOURCE_FAILED");
        }
        const bytes = new Uint8Array(this.#buffer.subarray(0, newline));
        this.#buffer = this.#buffer.subarray(newline + 1);
        try {
          return Object.freeze({
            bytes,
            object: parseRelayV2JsonObject(decodeRelayV2StrictUtf8(bytes), JSON_LIMITS),
          });
        } catch {
          throw controllerError("SOURCE_FAILED");
        }
      }
      if (this.#ended) {
        if (this.#buffer.byteLength !== 0) throw controllerError("SOURCE_FAILED");
        return null;
      }
      let result: IteratorResult<unknown>;
      try {
        result = await this.#iterator.next();
      } catch {
        throw controllerError("SOURCE_FAILED");
      }
      if (result.done) {
        this.#ended = true;
        continue;
      }
      if (!(result.value instanceof Uint8Array)
        || nodeTypes.isProxy(result.value)
        || result.value.byteLength < 1
        || result.value.byteLength > MAX_JSONL_FRAME_BYTES + 1) {
        throw controllerError("SOURCE_FAILED");
      }
      this.#buffer = Buffer.concat([this.#buffer, Buffer.from(result.value)]);
      const nextNewline = this.#buffer.indexOf(0x0a);
      if (nextNewline < 0 && this.#buffer.byteLength > MAX_JSONL_FRAME_BYTES) {
        throw controllerError("SOURCE_FAILED");
      }
      if (nextNewline > MAX_JSONL_FRAME_BYTES) throw controllerError("SOURCE_FAILED");
    }
  }
}

function exactJsonObject(
  value: unknown,
  keys: readonly string[],
  code: "HANDSHAKE_FAILED" | "SOURCE_FAILED",
): RelayV2JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw controllerError(code);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw controllerError(code);
  }
  return value as RelayV2JsonObject;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (typeof timer.unref === "function") timer.unref();
  });
}

class OwnedCodexAppServerNotificationByteSource
implements CodexAppServerNotificationByteSource {
  readonly #child: ChildProcess;
  readonly #reader: BoundedJsonLineReader;
  readonly #reaped: Promise<void>;
  readonly #processError: Promise<void>;
  #iteratorIssued = false;
  #cancelPromise: Promise<void> | null = null;

  constructor(child: ChildProcess, reader: BoundedJsonLineReader) {
    this.#child = child;
    this.#reader = reader;
    this.#reaped = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });
    this.#processError = new Promise<void>((resolve) => {
      let observed = false;
      // Keep a listener for the entire ChildProcess lifetime: EventEmitter
      // treats every unowned `error` as fatal, including errors after the
      // first spawn failure or during teardown.
      child.on("error", () => {
        if (observed) return;
        observed = true;
        resolve();
      });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#iteratorIssued) throw controllerError("SOURCE_FAILED");
    this.#iteratorIssued = true;
    return this.#notifications();
  }

  cancel(): Promise<void> {
    if (this.#cancelPromise !== null) return this.#cancelPromise;
    this.#cancelPromise = this.#cancelAndReap();
    return this.#cancelPromise;
  }

  nextHandshakeLine(): Promise<LineResult | null> {
    return Promise.race([
      this.#reader.next(),
      this.#processError.then(() => {
        throw controllerError("HANDSHAKE_FAILED");
      }),
    ]);
  }

  waitForHandshakeWrite(write: Promise<void>): Promise<void> {
    return Promise.race([
      write,
      this.#processError.then(() => {
        throw controllerError("HANDSHAKE_FAILED");
      }),
    ]);
  }

  async #cancelAndReap(): Promise<void> {
    try {
      this.#child.stdin?.end();
      if (this.#child.connected) this.#child.disconnect();
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill("SIGTERM");
        const terminated = await Promise.race([
          this.#reaped.then(() => true),
          delay(TERMINATE_TIMEOUT_MS).then(() => false),
        ]);
        if (!terminated) this.#child.kill("SIGKILL");
      }
      const killed = await Promise.race([
        this.#reaped.then(() => true),
        delay(KILL_TIMEOUT_MS).then(() => false),
      ]);
      if (!killed) throw controllerError("PROCESS_DRAIN_FAILED");
      this.#child.stdout?.destroy();
    } catch (error) {
      if (error instanceof RelayV2HostCodexAppServerProcessControllerError) throw error;
      throw controllerError("PROCESS_DRAIN_FAILED");
    }
  }

  async *#notifications(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const line = await Promise.race([
        this.#reader.next(),
        this.#processError.then(() => {
          throw controllerError("SOURCE_FAILED");
        }),
      ]);
      if (line === null) return;
      const method = line.object.method;
      if (typeof method !== "string" || !ACCEPTED_NOTIFICATION_METHODS.has(method)) continue;
      exactJsonObject(line.object, ["method", "params"], "SOURCE_FAILED");
      const framed = new Uint8Array(line.bytes.byteLength + 1);
      framed.set(line.bytes);
      framed[framed.byteLength - 1] = 0x0a;
      yield framed;
    }
  }
}

function validateInitializeResponse(line: LineResult): void {
  const envelope = exactJsonObject(line.object, ["id", "result"], "HANDSHAKE_FAILED");
  const result = exactJsonObject(
    envelope.result,
    ["userAgent", "codexHome", "platformFamily", "platformOs"],
    "HANDSHAKE_FAILED",
  );
  const prefix = `${CLIENT_NAME}/${CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0} (`;
  if (envelope.id !== 1
    || typeof result.userAgent !== "string"
    || !result.userAgent.startsWith(prefix)
    || typeof result.codexHome !== "string"
    || !isAbsolute(result.codexHome)
    || typeof result.platformFamily !== "string"
    || result.platformFamily.length === 0
    || typeof result.platformOs !== "string"
    || result.platformOs.length === 0) {
    throw controllerError("HANDSHAKE_FAILED");
  }
}

async function writeJsonLine(child: ChildProcess, value: Readonly<object>): Promise<void> {
  const stdin = child.stdin;
  if (stdin === null) throw controllerError("HANDSHAKE_FAILED");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  await new Promise<void>((resolve, reject) => {
    stdin.write(bytes, (error) => error === null || error === undefined
      ? resolve()
      : reject(controllerError("HANDSHAKE_FAILED")));
  });
}

async function initializeProcess(
  child: ChildProcess,
  source: OwnedCodexAppServerNotificationByteSource,
): Promise<void> {
  await source.waitForHandshakeWrite(writeJsonLine(child, Object.freeze({
    method: "initialize",
    id: 1,
    params: Object.freeze({
      clientInfo: Object.freeze({
        name: CLIENT_NAME,
        title: CLIENT_TITLE,
        version: CLIENT_VERSION,
      }),
    }),
  })));
  const response = await Promise.race([
    source.nextHandshakeLine(),
    delay(INITIALIZE_TIMEOUT_MS).then(() => {
      throw controllerError("HANDSHAKE_FAILED");
    }),
  ]);
  if (response === null) throw controllerError("HANDSHAKE_FAILED");
  validateInitializeResponse(response);
  await source.waitForHandshakeWrite(writeJsonLine(
    child,
    Object.freeze({ method: "initialized", params: Object.freeze({}) }),
  ));
}

function parseH2Target(
  input: unknown,
  options: Readonly<CapturedControllerOptions>,
): Readonly<RelayV2CanonicalResolvedSessionTarget> {
  let target: Readonly<Record<string, unknown>>;
  let processTarget: Readonly<Record<string, unknown>>;
  let managedTarget: Readonly<Record<string, unknown>>;
  try {
    target = exactDataObject(input, [
      "authorization", "hostEpoch", "discoveryGeneration", "scopeId", "processTarget",
      "capabilities", "sessionId", "backendInstanceKey", "managedTarget",
    ], false);
    processTarget = exactDataObject(target.processTarget, ["kind", "targetId"], false);
    managedTarget = exactDataObject(target.managedTarget, ["name", "kind", "incarnation"], false);
  } catch {
    throw controllerError("H2_BINDING_MISMATCH");
  }
  if (target.authorization !== "evidence_only"
    || target.hostEpoch !== options.hostEpoch
    || target.scopeId !== options.scopeId
    || target.sessionId !== options.sessionId
    || processTarget.kind !== "local"
    || !Array.isArray(target.capabilities)
    || nodeTypes.isProxy(target.capabilities)
    || (managedTarget.kind !== "worktree" && managedTarget.kind !== "terminal")) {
    throw controllerError("H2_BINDING_MISMATCH");
  }
  try {
    return Object.freeze({
      authorization: "evidence_only" as const,
      hostEpoch: opaque(target.hostEpoch),
      discoveryGeneration: opaque(target.discoveryGeneration),
      scopeId: opaque(target.scopeId),
      processTarget: Object.freeze({
        kind: "local" as const,
        targetId: opaque(processTarget.targetId),
      }),
      capabilities: Object.freeze(target.capabilities.map((value) => opaque(value))),
      sessionId: opaque(target.sessionId),
      backendInstanceKey: opaque(target.backendInstanceKey),
      managedTarget: Object.freeze({
        name: opaque(managedTarget.name),
        kind: managedTarget.kind,
        incarnation: opaque(managedTarget.incarnation),
      }),
    });
  } catch {
    throw controllerError("H2_BINDING_MISMATCH");
  }
}

/**
 * Explicit one-shot Host controller. It resolves the selected Session from H2,
 * revalidates and spawns the exact injected Codex artifact, verifies the
 * app-server initialize response for the 0.146.0/schema-2 lane, and transfers
 * only a filtered bounded notification source. Source cancellation owns stdin
 * disconnect, TERM/KILL escalation, close/reap, and stdout drain.
 */
export class RelayV2HostCodexAppServerStructuredNotificationProcessController
implements CodexAppServerProcessControllerPort {
  readonly #options: Readonly<CapturedControllerOptions>;
  #claimed = false;

  constructor(
    hostId: string,
    hostEpoch: string,
    resolver: RelayV2CanonicalResourceResolverPort,
    input: RelayV2HostCodexAppServerStructuredNotificationProcessOptions,
  ) {
    const fields = exactDataObject(
      input,
      ["executableArtifact", "scopeId", "sessionId"],
      true,
    );
    const artifact = typeof fields.executableArtifact === "object"
      && fields.executableArtifact !== null
      && !nodeTypes.isProxy(fields.executableArtifact)
      ? executableArtifacts.get(fields.executableArtifact)
      : undefined;
    if (artifact === undefined
      || typeof resolver !== "object"
      || resolver === null
      || nodeTypes.isProxy(resolver)
      || typeof resolver.captureToken !== "function"
      || typeof resolver.resolveSession !== "function"
      || nodeTypes.isProxy(resolver.captureToken)
      || nodeTypes.isProxy(resolver.resolveSession)) {
      throw controllerError("INVALID_OPTIONS");
    }
    this.#options = Object.freeze({
      artifact,
      hostId: opaque(hostId),
      hostEpoch: opaque(hostEpoch),
      scopeId: opaque(fields.scopeId),
      sessionId: opaque(fields.sessionId),
      resolver,
    });
  }

  async claimControlledProcess(): Promise<Readonly<CodexAppServerControlledProcess>> {
    if (this.#claimed) throw controllerError("ALREADY_CLAIMED");
    this.#claimed = true;
    const options = this.#options;
    let target: Readonly<RelayV2CanonicalResolvedSessionTarget>;
    try {
      const token = await options.resolver.captureToken(options.hostEpoch);
      target = parseH2Target(
        await options.resolver.resolveSession(token, options.scopeId, options.sessionId),
        options,
      );
    } catch (error) {
      if (error instanceof RelayV2HostCodexAppServerProcessControllerError) throw error;
      throw controllerError("H2_BINDING_MISMATCH");
    }
    const beforeSpawn = await inspectExecutable(options.artifact.canonicalPath, options.artifact.sha256);
    if (!sameArtifact(options.artifact, beforeSpawn)) throw controllerError("ARTIFACT_MISMATCH");

    let child: ChildProcess;
    try {
      child = spawn(options.artifact.canonicalPath, ["app-server", "--listen", "stdio://"], {
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      throw controllerError("SPAWN_FAILED");
    }
    if (child.stdin === null || child.stdout === null) {
      child.kill("SIGKILL");
      throw controllerError("SPAWN_FAILED");
    }
    const reader = new BoundedJsonLineReader(child.stdout);
    const source = new OwnedCodexAppServerNotificationByteSource(child, reader);
    try {
      await initializeProcess(child, source);
      const afterSpawn = await inspectExecutable(options.artifact.canonicalPath, options.artifact.sha256);
      if (!sameArtifact(options.artifact, afterSpawn)) {
        throw controllerError("ARTIFACT_MISMATCH");
      }
      return Object.freeze({
        binding: Object.freeze({
          hostId: options.hostId,
          hostEpoch: options.hostEpoch,
          scopeId: target.scopeId,
          sessionId: target.sessionId,
          backendInstanceKey: target.backendInstanceKey,
          managedIncarnation: target.managedTarget.incarnation,
        }),
        notificationSource: source,
        version: Object.freeze({
          provider: CODEX_APP_SERVER_V2_PROVIDER,
          providerVersion: CODEX_APP_SERVER_V2_PROVIDER_VERSION_0_146_0,
          schemaVersion: CODEX_APP_SERVER_V2_SCHEMA_VERSION,
        }),
      });
    } catch (error) {
      await source.cancel().catch(() => undefined);
      if (error instanceof RelayV2HostCodexAppServerProcessControllerError) throw error;
      throw controllerError("HANDSHAKE_FAILED");
    }
  }
}
