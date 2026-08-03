import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  promises as fsPromises,
  type BigIntStats,
  type FileHandle,
} from "node:fs";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import { types as nodeTypes } from "node:util";

import { issueManagedSessionIncarnation } from "../../../../state.js";
import { TMUX_RPC_V2_BIRTH_MARKER_OPTION } from "../../../../tmux.js";

export const CODEX_ROLLOUT_FILE_PROVIDER_VERSION = "0.146.0" as const;
export const CODEX_ROLLOUT_MAX_TRUSTED_EXECUTABLE_BYTES = 384 * 1024 * 1024;

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_FOLLOW_READ_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_TMUX_OUTPUT_BYTES = 64 * 1024;
const MAX_PS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LSOF_OUTPUT_BYTES = 1024 * 1024;
const FIELD_SEPARATOR = "\x1f";

export type CodexRolloutFileSourceErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_SELECTION"
  | "INSPECTION_FAILED"
  | "SESSION_MISMATCH"
  | "PROCESS_MISMATCH"
  | "ROLLOUT_NOT_UNIQUE"
  | "FILE_UNSAFE"
  | "SESSION_META_MISMATCH"
  | "STALE_EVIDENCE"
  | "ALREADY_OPENED"
  | "SEALED";

const ERROR_MESSAGES: Readonly<Record<CodexRolloutFileSourceErrorCode, string>> = Object.freeze({
  INVALID_OPTIONS: "Codex rollout source options are invalid",
  INVALID_SELECTION: "Codex rollout Session selection is invalid",
  INSPECTION_FAILED: "Codex rollout process inspection failed",
  SESSION_MISMATCH: "Managed tmux Session does not match H2 evidence",
  PROCESS_MISMATCH: "Managed pane does not contain one exact trusted Codex process",
  ROLLOUT_NOT_UNIQUE: "Trusted Codex process does not own one exact rollout file",
  FILE_UNSAFE: "Codex rollout file identity is unsafe",
  SESSION_META_MISMATCH: "Codex rollout session_meta does not match the managed Session",
  STALE_EVIDENCE: "Codex rollout Session or process evidence changed during open",
  ALREADY_OPENED: "Codex rollout source was already opened",
  SEALED: "Codex rollout source authority is sealed",
});

export class CodexRolloutFileSourceError extends Error {
  constructor(readonly code: CodexRolloutFileSourceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexRolloutFileSourceError";
  }
}

export interface CodexRolloutManagedSessionSelection {
  readonly sessionName: string;
  readonly managedIncarnation: string;
  readonly expectedCwd: string;
}

export interface CodexRolloutTmuxPaneSnapshot {
  readonly sessionName: string;
  readonly managedIncarnation: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly paneTty: string;
  readonly cwd: string;
}

export interface CodexRolloutProcessSnapshot {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly foregroundProcessGroupId: number;
  readonly tty: string;
  readonly startToken: string;
  readonly executablePath: string;
  readonly trustedExecutable: boolean;
}

export interface CodexRolloutOpenFilesSnapshot {
  readonly pid: number;
  readonly trustedExecutableVnode: boolean;
  readonly paths: readonly string[];
}

export interface CodexRolloutOpenFileSnapshot {
  readonly resolvedPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly ownerUid: bigint;
  readonly linkCount: bigint;
  readonly regular: boolean;
  readonly size: bigint;
}

export interface CodexRolloutOpenFileHandle {
  inspect(): Promise<Readonly<CodexRolloutOpenFileSnapshot>>;
  read(position: bigint, maximumBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface CodexRolloutTmuxInspectionPort {
  inspectSinglePane(
    selection: Readonly<CodexRolloutManagedSessionSelection>,
  ): Promise<Readonly<CodexRolloutTmuxPaneSnapshot>>;
}

export interface CodexRolloutProcessInspectionPort {
  inspectPaneDescendants(
    pane: Readonly<CodexRolloutTmuxPaneSnapshot>,
  ): Promise<readonly Readonly<CodexRolloutProcessSnapshot>[]>;
}

export interface CodexRolloutOpenFileInspectionPort {
  inspectOpenFiles(pid: number): Promise<Readonly<CodexRolloutOpenFilesSnapshot>>;
  openNoFollow(path: string): Promise<CodexRolloutOpenFileHandle>;
}

declare const CODEX_ROLLOUT_OPEN_SOURCE_BRAND: unique symbol;
export interface CodexRolloutOpenByteSourceIdentity {
  readonly [CODEX_ROLLOUT_OPEN_SOURCE_BRAND]: true;
}

export interface CodexRolloutDurableCut {
  readonly device: bigint;
  readonly inode: bigint;
  readonly offset: bigint;
}

export interface CodexRolloutFollowerByteSource {
  read(position: bigint, maximumBytes: number): Promise<Uint8Array>;
  inspectDurableCut(): Promise<Readonly<CodexRolloutDurableCut>>;
  closeAndDrain(): Promise<void>;
}

export interface CodexRolloutOpenedSource {
  readonly providerVersion: typeof CODEX_ROLLOUT_FILE_PROVIDER_VERSION;
  readonly sessionName: string;
  readonly managedIncarnation: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly codexPid: number;
  readonly sourceIdentity: CodexRolloutOpenByteSourceIdentity;
  readonly firstRecordEndOffset: bigint;
  readonly durableCut: Readonly<CodexRolloutDurableCut>;
}

export interface CodexRolloutFileSourceAuthorityOptions {
  readonly platform: "darwin";
  readonly accountHome: string;
  readonly accountUid: number;
  readonly selection: Readonly<CodexRolloutManagedSessionSelection>;
  readonly tmux: CodexRolloutTmuxInspectionPort;
  readonly processes: CodexRolloutProcessInspectionPort;
  readonly openFiles: CodexRolloutOpenFileInspectionPort;
}

export interface DarwinCodexRolloutInspectionAdapterInput {
  readonly tmuxExecutablePath: string;
  readonly trustedCodexExecutablePath: string;
  readonly trustedCodexExecutableSha256: string;
}

interface TrustedExecutableRecord {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface NormalizedPorts {
  inspectSinglePane(selection: Readonly<CodexRolloutManagedSessionSelection>): unknown;
  inspectPaneDescendants(pane: Readonly<CodexRolloutTmuxPaneSnapshot>): unknown;
  inspectOpenFiles(pid: number): unknown;
  openNoFollow(path: string): unknown;
}

interface OpenSourceRecord {
  claim(): CodexRolloutFollowerByteSource;
}

const openSourceRecords = new WeakMap<object, Readonly<OpenSourceRecord>>();

function sourceError(code: CodexRolloutFileSourceErrorCode): CodexRolloutFileSourceError {
  return new CodexRolloutFileSourceError(code);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  code: CodexRolloutFileSourceErrorCode,
  frozen = true,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value) || !isPlainObject(value) || (frozen && !Object.isFrozen(value))) {
    throw sourceError(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))) throw sourceError(code);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || (frozen && (descriptor.configurable || descriptor.writable))) throw sourceError(code);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function dataMethod(value: unknown, key: string): { owner: object; method: Function } {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw sourceError("INVALID_OPTIONS");
  }
  let cursor: object | null = value;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function"
        || nodeTypes.isProxy(descriptor.value)) throw sourceError("INVALID_OPTIONS");
      return { owner: value, method: descriptor.value };
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw sourceError("INVALID_OPTIONS");
}

function bounded(value: unknown, maximumBytes = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || /[\0\r\n]/u.test(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw sourceError("INVALID_SELECTION");
  }
  return value;
}

function absolutePath(value: unknown, code: CodexRolloutFileSourceErrorCode): string {
  try {
    const path = bounded(value);
    if (!isAbsolute(path) || normalize(path) !== path) throw sourceError(code);
    return path;
  } catch {
    throw sourceError(code);
  }
}

function positiveInteger(value: unknown, code: CodexRolloutFileSourceErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw sourceError(code);
  return value as number;
}

function normalizeSelection(value: unknown): Readonly<CodexRolloutManagedSessionSelection> {
  const fields = exactObject(
    value,
    ["sessionName", "managedIncarnation", "expectedCwd"],
    "INVALID_SELECTION",
  );
  const sessionName = bounded(fields.sessionName, 128);
  const managedIncarnation = bounded(fields.managedIncarnation, 128);
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/u.test(managedIncarnation)) {
    throw sourceError("INVALID_SELECTION");
  }
  return Object.freeze({
    sessionName,
    managedIncarnation,
    expectedCwd: absolutePath(fields.expectedCwd, "INVALID_SELECTION"),
  });
}

function normalizePorts(options: Readonly<Record<string, unknown>>): Readonly<NormalizedPorts> {
  const tmux = dataMethod(options.tmux, "inspectSinglePane");
  const processes = dataMethod(options.processes, "inspectPaneDescendants");
  const inspectOpenFiles = dataMethod(options.openFiles, "inspectOpenFiles");
  const openNoFollow = dataMethod(options.openFiles, "openNoFollow");
  return Object.freeze({
    inspectSinglePane: (selection: Readonly<CodexRolloutManagedSessionSelection>) =>
      tmux.method.call(tmux.owner, selection),
    inspectPaneDescendants: (pane: Readonly<CodexRolloutTmuxPaneSnapshot>) =>
      processes.method.call(processes.owner, pane),
    inspectOpenFiles: (pid: number) => inspectOpenFiles.method.call(inspectOpenFiles.owner, pid),
    openNoFollow: (path: string) => openNoFollow.method.call(openNoFollow.owner, path),
  });
}

function requirePromise(value: unknown): Promise<unknown> {
  if (!nodeTypes.isPromise(value)) throw sourceError("INSPECTION_FAILED");
  return value as Promise<unknown>;
}

function normalizePane(
  value: unknown,
  selection: Readonly<CodexRolloutManagedSessionSelection>,
): Readonly<CodexRolloutTmuxPaneSnapshot> {
  const fields = exactObject(
    value,
    ["sessionName", "managedIncarnation", "paneId", "panePid", "paneTty", "cwd"],
    "SESSION_MISMATCH",
  );
  if (fields.sessionName !== selection.sessionName
    || fields.managedIncarnation !== selection.managedIncarnation
    || fields.cwd !== selection.expectedCwd
    || typeof fields.paneId !== "string" || !/^%[0-9]+$/u.test(fields.paneId)
    || typeof fields.paneTty !== "string" || !fields.paneTty.startsWith("/dev/")) {
    throw sourceError("SESSION_MISMATCH");
  }
  return Object.freeze({
    sessionName: selection.sessionName,
    managedIncarnation: selection.managedIncarnation,
    paneId: fields.paneId,
    panePid: positiveInteger(fields.panePid, "SESSION_MISMATCH"),
    paneTty: fields.paneTty,
    cwd: selection.expectedCwd,
  });
}

function normalizeProcesses(
  value: unknown,
  pane: Readonly<CodexRolloutTmuxPaneSnapshot>,
): { readonly records: readonly Readonly<CodexRolloutProcessSnapshot>[]; readonly codexPid: number } {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || !Object.isFrozen(value)
    || value.length < 2 || value.length > 4_096) throw sourceError("PROCESS_MISMATCH");
  const records = value.map((entry) => {
    const fields = exactObject(entry, [
      "pid", "parentPid", "processGroupId", "foregroundProcessGroupId", "tty",
      "startToken", "executablePath", "trustedExecutable",
    ], "PROCESS_MISMATCH");
    const pid = positiveInteger(fields.pid, "PROCESS_MISMATCH");
    const parentPid = Number.isSafeInteger(fields.parentPid) && (fields.parentPid as number) >= 0
      ? fields.parentPid as number : (() => { throw sourceError("PROCESS_MISMATCH"); })();
    const processGroupId = positiveInteger(fields.processGroupId, "PROCESS_MISMATCH");
    const foregroundProcessGroupId = Number.isSafeInteger(fields.foregroundProcessGroupId)
      && (fields.foregroundProcessGroupId as number) >= 0
      ? fields.foregroundProcessGroupId as number
      : (() => { throw sourceError("PROCESS_MISMATCH"); })();
    if (typeof fields.tty !== "string" || typeof fields.startToken !== "string"
      || fields.startToken.length < 1 || typeof fields.executablePath !== "string"
      || fields.executablePath.length < 1 || /[\0\r\n]/u.test(fields.executablePath)
      || Buffer.byteLength(fields.executablePath, "utf8") > 4_096
      || typeof fields.trustedExecutable !== "boolean"
      || (fields.trustedExecutable && !isAbsolute(fields.executablePath))) {
      throw sourceError("PROCESS_MISMATCH");
    }
    return Object.freeze({
      pid, parentPid, processGroupId, foregroundProcessGroupId,
      tty: fields.tty, startToken: fields.startToken,
      executablePath: fields.executablePath,
      trustedExecutable: fields.trustedExecutable,
    });
  }).sort((left, right) => left.pid - right.pid);
  const byPid = new Map(records.map((record) => [record.pid, record]));
  if (byPid.size !== records.length || !byPid.has(pane.panePid)) throw sourceError("PROCESS_MISMATCH");
  for (const record of records) {
    const seen = new Set<number>();
    let current: Readonly<CodexRolloutProcessSnapshot> | undefined = record;
    while (current.pid !== pane.panePid) {
      if (seen.has(current.pid)) throw sourceError("PROCESS_MISMATCH");
      seen.add(current.pid);
      current = byPid.get(current.parentPid);
      if (current === undefined) throw sourceError("PROCESS_MISMATCH");
    }
  }
  const paneTty = basename(pane.paneTty);
  const trusted = records.filter((record) => record.trustedExecutable);
  if (trusted.length !== 1 || trusted[0].tty !== paneTty
    || trusted[0].processGroupId !== trusted[0].foregroundProcessGroupId) {
    throw sourceError("PROCESS_MISMATCH");
  }
  return Object.freeze({ records: Object.freeze(records), codexPid: trusted[0].pid });
}

function processFingerprint(records: readonly Readonly<CodexRolloutProcessSnapshot>[]): string {
  return JSON.stringify(records);
}

function normalizeOpenFiles(value: unknown, pid: number): Readonly<CodexRolloutOpenFilesSnapshot> {
  const fields = exactObject(
    value,
    ["pid", "trustedExecutableVnode", "paths"],
    "INSPECTION_FAILED",
  );
  if (fields.pid !== pid || fields.trustedExecutableVnode !== true
    || !Array.isArray(fields.paths) || nodeTypes.isProxy(fields.paths)
    || !Object.isFrozen(fields.paths) || fields.paths.length > 16_384) {
    throw sourceError("PROCESS_MISMATCH");
  }
  const paths = fields.paths.map((path) => absolutePath(path, "INSPECTION_FAILED"));
  return Object.freeze({ pid, trustedExecutableVnode: true, paths: Object.freeze(paths) });
}

function selectRolloutPath(
  snapshot: Readonly<CodexRolloutOpenFilesSnapshot>,
  sessionsRoot: string,
): string {
  const matches = snapshot.paths.filter((path) => {
    const remainder = relative(sessionsRoot, path);
    return remainder.length > 0 && !remainder.startsWith("..") && !isAbsolute(remainder)
      && /^rollout-.*\.jsonl$/u.test(basename(path));
  });
  if (matches.length !== 1 || new Set(matches).size !== 1) throw sourceError("ROLLOUT_NOT_UNIQUE");
  return matches[0];
}

function normalizeFileSnapshot(
  value: unknown,
  path: string,
  accountUid: bigint,
): Readonly<CodexRolloutOpenFileSnapshot> {
  const fields = exactObject(
    value,
    ["resolvedPath", "device", "inode", "ownerUid", "linkCount", "regular", "size"],
    "FILE_UNSAFE",
  );
  if (fields.resolvedPath !== path || typeof fields.device !== "bigint"
    || typeof fields.inode !== "bigint" || typeof fields.ownerUid !== "bigint"
    || typeof fields.linkCount !== "bigint" || typeof fields.size !== "bigint"
    || fields.regular !== true || fields.device < 0n || fields.inode < 1n
    || fields.ownerUid !== accountUid || fields.linkCount !== 1n || fields.size < 1n) {
    throw sourceError("FILE_UNSAFE");
  }
  return Object.freeze({
    resolvedPath: path,
    device: fields.device,
    inode: fields.inode,
    ownerUid: fields.ownerUid,
    linkCount: fields.linkCount,
    regular: true,
    size: fields.size,
  });
}

function sameFileIdentity(
  left: Readonly<CodexRolloutOpenFileSnapshot>,
  right: Readonly<CodexRolloutOpenFileSnapshot>,
): boolean {
  return left.resolvedPath === right.resolvedPath && left.device === right.device
    && left.inode === right.inode && left.ownerUid === right.ownerUid
    && left.linkCount === right.linkCount && left.regular === right.regular
    && right.size >= left.size;
}

class OwnedRolloutFollowerByteSource implements CodexRolloutFollowerByteSource {
  readonly #handle: CodexRolloutOpenFileHandle;
  readonly #path: string;
  readonly #accountUid: bigint;
  readonly #identity: Readonly<CodexRolloutOpenFileSnapshot>;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    handle: CodexRolloutOpenFileHandle,
    path: string,
    accountUid: bigint,
    identity: Readonly<CodexRolloutOpenFileSnapshot>,
  ) {
    this.#handle = handle;
    this.#path = path;
    this.#accountUid = accountUid;
    this.#identity = identity;
  }

  async read(position: bigint, maximumBytes: number): Promise<Uint8Array> {
    if (this.#closed || position < 0n || !Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1 || maximumBytes > MAX_FOLLOW_READ_BYTES) throw sourceError("SEALED");
    const before = normalizeFileSnapshot(
      await this.#handle.inspect(),
      this.#path,
      this.#accountUid,
    );
    if (!sameFileIdentity(this.#identity, before)) throw sourceError("FILE_UNSAFE");
    const bytes = await this.#handle.read(position, maximumBytes);
    if (!(bytes instanceof Uint8Array) || nodeTypes.isProxy(bytes)
      || bytes.byteLength > maximumBytes) throw sourceError("FILE_UNSAFE");
    const after = normalizeFileSnapshot(
      await this.#handle.inspect(),
      this.#path,
      this.#accountUid,
    );
    if (!sameFileIdentity(before, after)) throw sourceError("FILE_UNSAFE");
    return new Uint8Array(bytes);
  }

  async inspectDurableCut(): Promise<Readonly<CodexRolloutDurableCut>> {
    if (this.#closed) throw sourceError("SEALED");
    const current = normalizeFileSnapshot(
      await this.#handle.inspect(),
      this.#path,
      this.#accountUid,
    );
    if (!sameFileIdentity(this.#identity, current)) throw sourceError("FILE_UNSAFE");
    return Object.freeze({ device: current.device, inode: current.inode, offset: current.size });
  }

  closeAndDrain(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#handle.close();
    return this.#closePromise;
  }
}

/** One-shot ownership transfer from the opener to the future rollout follower. */
export function claimCodexRolloutOpenByteSource(
  identity: CodexRolloutOpenByteSourceIdentity,
): CodexRolloutFollowerByteSource {
  if (arguments.length !== 1 || typeof identity !== "object" || identity === null
    || nodeTypes.isProxy(identity)) throw sourceError("SEALED");
  const record = openSourceRecords.get(identity);
  if (record === undefined) throw sourceError("SEALED");
  openSourceRecords.delete(identity);
  return record.claim();
}

function parseSessionMeta(bytes: Uint8Array, expectedCwd: string): {
  readonly threadId: string;
  readonly endOffset: bigint;
} {
  const newline = bytes.indexOf(0x0a);
  if (newline < 1 || newline >= MAX_HEADER_BYTES) throw sourceError("SESSION_META_MISMATCH");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)));
  } catch {
    throw sourceError("SESSION_META_MISMATCH");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw sourceError("SESSION_META_MISMATCH");
  }
  const record = parsed as Record<string, unknown>;
  const payload = record.payload;
  if (record.type !== "session_meta" || typeof payload !== "object" || payload === null
    || Array.isArray(payload)) throw sourceError("SESSION_META_MISMATCH");
  const meta = payload as Record<string, unknown>;
  if (typeof meta.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(meta.id)
    || meta.cwd !== expectedCwd || meta.cli_version !== CODEX_ROLLOUT_FILE_PROVIDER_VERSION) {
    throw sourceError("SESSION_META_MISMATCH");
  }
  return Object.freeze({ threadId: meta.id, endOffset: BigInt(newline + 1) });
}

function normalizeHandle(value: unknown): CodexRolloutOpenFileHandle {
  const inspect = dataMethod(value, "inspect");
  const read = dataMethod(value, "read");
  const close = dataMethod(value, "close");
  return Object.freeze({
    inspect: () => requirePromise(inspect.method.call(inspect.owner)) as Promise<Readonly<CodexRolloutOpenFileSnapshot>>,
    read: (position: bigint, maximumBytes: number) =>
      requirePromise(read.method.call(read.owner, position, maximumBytes)) as Promise<Uint8Array>,
    close: () => requirePromise(close.method.call(close.owner)) as Promise<void>,
  });
}

/**
 * Default-off, read-only owner. H2 supplies the exact managed name/incarnation
 * and cwd; this owner re-establishes those facts through tmux and binds them to
 * one live trusted Codex process and its already-open rollout vnode. It never
 * reads pane output and exposes no path or descriptor in its public result.
 */
export class CodexRolloutFileSourceAuthority {
  readonly #accountUid: bigint;
  readonly #selection: Readonly<CodexRolloutManagedSessionSelection>;
  readonly #sessionsRoot: string;
  readonly #ports: Readonly<NormalizedPorts>;
  #state: "disabled" | "opening" | "opened" | "sealed" | "closed" = "disabled";
  #handle: CodexRolloutOpenFileHandle | null = null;
  #sourceIdentity: CodexRolloutOpenByteSourceIdentity | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(options: Readonly<CodexRolloutFileSourceAuthorityOptions>) {
    const fields = exactObject(options, [
      "platform", "accountHome", "accountUid", "selection", "tmux", "processes", "openFiles",
    ], "INVALID_OPTIONS");
    if (fields.platform !== "darwin" || !Number.isSafeInteger(fields.accountUid)
      || (fields.accountUid as number) < 0) throw sourceError("INVALID_OPTIONS");
    const accountHome = absolutePath(fields.accountHome, "INVALID_OPTIONS");
    this.#accountUid = BigInt(fields.accountUid as number);
    this.#selection = normalizeSelection(fields.selection);
    this.#sessionsRoot = join(accountHome, ".codex", "sessions");
    this.#ports = normalizePorts(fields);
  }

  get state(): string {
    return this.#state;
  }

  async open(): Promise<Readonly<CodexRolloutOpenedSource>> {
    if (arguments.length !== 0) throw sourceError("INVALID_OPTIONS");
    if (this.#state !== "disabled") {
      throw sourceError(this.#state === "opened" ? "ALREADY_OPENED" : "SEALED");
    }
    this.#state = "opening";
    let handle: CodexRolloutOpenFileHandle | null = null;
    try {
      const pane = normalizePane(
        await requirePromise(this.#ports.inspectSinglePane(this.#selection)),
        this.#selection,
      );
      const processes = normalizeProcesses(
        await requirePromise(this.#ports.inspectPaneDescendants(pane)),
        pane,
      );
      const openFiles = normalizeOpenFiles(
        await requirePromise(this.#ports.inspectOpenFiles(processes.codexPid)),
        processes.codexPid,
      );
      const rolloutPath = selectRolloutPath(openFiles, this.#sessionsRoot);
      handle = normalizeHandle(await requirePromise(this.#ports.openNoFollow(rolloutPath)));
      const before = normalizeFileSnapshot(
        await handle.inspect(),
        rolloutPath,
        this.#accountUid,
      );
      const headerValue = await handle.read(0n, MAX_HEADER_BYTES);
      if (!(headerValue instanceof Uint8Array) || nodeTypes.isProxy(headerValue)
        || headerValue.byteLength < 1 || headerValue.byteLength > MAX_HEADER_BYTES) {
        throw sourceError("SESSION_META_MISMATCH");
      }
      const meta = parseSessionMeta(new Uint8Array(headerValue), this.#selection.expectedCwd);
      const afterRead = normalizeFileSnapshot(
        await handle.inspect(),
        rolloutPath,
        this.#accountUid,
      );
      if (!sameFileIdentity(before, afterRead) || meta.endOffset > afterRead.size) {
        throw sourceError("FILE_UNSAFE");
      }

      const finalPane = normalizePane(
        await requirePromise(this.#ports.inspectSinglePane(this.#selection)),
        this.#selection,
      );
      const finalProcesses = normalizeProcesses(
        await requirePromise(this.#ports.inspectPaneDescendants(finalPane)),
        finalPane,
      );
      const finalOpenFiles = normalizeOpenFiles(
        await requirePromise(this.#ports.inspectOpenFiles(finalProcesses.codexPid)),
        finalProcesses.codexPid,
      );
      const finalSnapshot = normalizeFileSnapshot(
        await handle.inspect(),
        rolloutPath,
        this.#accountUid,
      );
      if (JSON.stringify(finalPane) !== JSON.stringify(pane)
        || finalProcesses.codexPid !== processes.codexPid
        || processFingerprint(finalProcesses.records) !== processFingerprint(processes.records)
        || selectRolloutPath(finalOpenFiles, this.#sessionsRoot) !== rolloutPath
        || !sameFileIdentity(afterRead, finalSnapshot)) {
        throw sourceError("STALE_EVIDENCE");
      }

      const sourceIdentity = Object.freeze(Object.create(null)) as CodexRolloutOpenByteSourceIdentity;
      this.#handle = handle;
      this.#sourceIdentity = sourceIdentity;
      openSourceRecords.set(sourceIdentity, Object.freeze({
        claim: (): CodexRolloutFollowerByteSource => {
          if (this.#handle !== handle || this.#sourceIdentity !== sourceIdentity
            || this.#state !== "opened") throw sourceError("SEALED");
          this.#handle = null;
          this.#sourceIdentity = null;
          return Object.freeze(new OwnedRolloutFollowerByteSource(
            handle,
            rolloutPath,
            this.#accountUid,
            finalSnapshot,
          ));
        },
      }));
      this.#state = "opened";
      return Object.freeze({
        providerVersion: CODEX_ROLLOUT_FILE_PROVIDER_VERSION,
        sessionName: this.#selection.sessionName,
        managedIncarnation: this.#selection.managedIncarnation,
        threadId: meta.threadId,
        cwd: this.#selection.expectedCwd,
        codexPid: processes.codexPid,
        sourceIdentity,
        firstRecordEndOffset: meta.endOffset,
        durableCut: Object.freeze({
          device: finalSnapshot.device,
          inode: finalSnapshot.inode,
          offset: finalSnapshot.size,
        }),
      });
    } catch (error) {
      this.#state = "sealed";
      await handle?.close().catch(() => undefined);
      if (error instanceof CodexRolloutFileSourceError) throw error;
      throw sourceError("INSPECTION_FAILED");
    }
  }

  closeAndDrain(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#state = "closed";
    const handle = this.#handle;
    if (this.#sourceIdentity !== null) openSourceRecords.delete(this.#sourceIdentity);
    this.#handle = null;
    this.#sourceIdentity = null;
    this.#closePromise = handle === null ? Promise.resolve() : handle.close();
    return this.#closePromise;
  }
}

function execReadOnly(executable: string, argv: readonly string[], maximumBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...argv], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: maximumBytes,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null || typeof stdout !== "string"
        || Buffer.byteLength(stdout, "utf8") > maximumBytes) {
        reject(sourceError("INSPECTION_FAILED"));
        return;
      }
      resolve(stdout);
    });
  });
}

function exactSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw sourceError("INVALID_OPTIONS");
  }
  return value;
}

async function captureTrustedExecutable(path: string, expectedSha256: string): Promise<TrustedExecutableRecord> {
  let handle: FileHandle | null = null;
  try {
    const canonical = await fsPromises.realpath(path);
    if (canonical !== path) throw sourceError("INVALID_OPTIONS");
    handle = await fsPromises.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
    if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n
      || stat.size > BigInt(CODEX_ROLLOUT_MAX_TRUSTED_EXECUTABLE_BYTES)
      || (stat.mode & 0o111n) === 0n
      || (uid !== null && stat.uid !== uid && stat.uid !== 0n)) throw sourceError("INVALID_OPTIONS");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < Number(stat.size)) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset);
      if (read.bytesRead < 1) throw sourceError("INVALID_OPTIONS");
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const actual = Buffer.from(hash.digest("hex"), "hex");
    const expected = Buffer.from(expectedSha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw sourceError("INVALID_OPTIONS");
    }
    return Object.freeze({ path, device: stat.dev, inode: stat.ino });
  } catch (error) {
    if (error instanceof CodexRolloutFileSourceError) throw error;
    throw sourceError("INVALID_OPTIONS");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class DarwinOpenRolloutHandle implements CodexRolloutOpenFileHandle {
  readonly #path: string;
  readonly #handle: FileHandle;

  constructor(path: string, handle: FileHandle) {
    this.#path = path;
    this.#handle = handle;
  }

  async inspect(): Promise<Readonly<CodexRolloutOpenFileSnapshot>> {
    const [resolvedPath, pathStat, descriptorStat] = await Promise.all([
      fsPromises.realpath(this.#path),
      fsPromises.lstat(this.#path, { bigint: true }),
      this.#handle.stat({ bigint: true }),
    ]);
    if (resolvedPath !== this.#path || pathStat.isSymbolicLink()
      || pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
      throw sourceError("FILE_UNSAFE");
    }
    return fileSnapshotFromStat(resolvedPath, descriptorStat);
  }

  async read(position: bigint, maximumBytes: number): Promise<Uint8Array> {
    if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || maximumBytes > MAX_FOLLOW_READ_BYTES) {
      throw sourceError("FILE_UNSAFE");
    }
    const buffer = Buffer.alloc(maximumBytes);
    const result = await this.#handle.read(buffer, 0, maximumBytes, Number(position));
    return new Uint8Array(buffer.subarray(0, result.bytesRead));
  }

  close(): Promise<void> {
    return this.#handle.close();
  }
}

function fileSnapshotFromStat(path: string, stat: BigIntStats): Readonly<CodexRolloutOpenFileSnapshot> {
  return Object.freeze({
    resolvedPath: path,
    device: stat.dev,
    inode: stat.ino,
    ownerUid: stat.uid,
    linkCount: stat.nlink,
    regular: stat.isFile(),
    size: stat.size,
  });
}

interface LsofRecord { fd: string; type: string; device: string; inode: string; name: string }

function parseLsof(stdout: string, expectedPid: number): readonly Readonly<LsofRecord>[] {
  const tokens = stdout.split(/[\0\n]/u).filter((token) => token.length > 0);
  if (!tokens.includes(`p${expectedPid}`)) throw sourceError("INSPECTION_FAILED");
  const records: LsofRecord[] = [];
  let current: Partial<LsofRecord> | null = null;
  for (const token of tokens) {
    const prefix = token[0];
    const value = token.slice(1);
    if (prefix === "f") {
      if (current !== null) records.push(current as LsofRecord);
      current = { fd: value, type: "", device: "", inode: "", name: "" };
    } else if (current !== null) {
      if (prefix === "t") current.type = value;
      else if (prefix === "D") current.device = value;
      else if (prefix === "i") current.inode = value;
      else if (prefix === "n") current.name = value;
    }
  }
  if (current !== null) records.push(current as LsofRecord);
  return Object.freeze(records.map((record) => Object.freeze(record)));
}

/** Real, read-only Darwin adapter. No shell and no process/tmux mutation. */
export class DarwinCodexRolloutInspectionAdapter
implements CodexRolloutTmuxInspectionPort,
CodexRolloutProcessInspectionPort,
CodexRolloutOpenFileInspectionPort {
  readonly #tmuxPath: string;
  readonly #trusted: Readonly<TrustedExecutableRecord>;

  constructor(token: symbol, tmuxPath: string, trusted: Readonly<TrustedExecutableRecord>) {
    if (token !== DARWIN_ADAPTER_TOKEN) throw sourceError("INVALID_OPTIONS");
    this.#tmuxPath = tmuxPath;
    this.#trusted = trusted;
  }

  async inspectSinglePane(
    selection: Readonly<CodexRolloutManagedSessionSelection>,
  ): Promise<Readonly<CodexRolloutTmuxPaneSnapshot>> {
    const format = [
      "#{socket_path}", "#{pid}", "#{start_time}", "#{session_id}", "#{session_name}",
      "#{session_created}", `#{${TMUX_RPC_V2_BIRTH_MARKER_OPTION}}`, "#{pane_id}",
      "#{pane_pid}", "#{pane_tty}", "#{pane_current_path}", "#{pane_active}",
    ].join(FIELD_SEPARATOR);
    const stdout = await execReadOnly(
      this.#tmuxPath,
      ["list-panes", "-t", `=${selection.sessionName}`, "-F", format],
      MAX_TMUX_OUTPUT_BYTES,
    );
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== 1) throw sourceError("SESSION_MISMATCH");
    const fields = lines[0].split(FIELD_SEPARATOR);
    if (fields.length !== 12 || fields[4] !== selection.sessionName || fields[11] !== "1") {
      throw sourceError("SESSION_MISMATCH");
    }
    const birthMarker = fields[6] === "" ? null : fields[6];
    if (birthMarker !== null && !/^twbirth2\.[A-Za-z0-9_-]{22}$/u.test(birthMarker)) {
      throw sourceError("SESSION_MISMATCH");
    }
    const incarnation = issueManagedSessionIncarnation({
      serverSocketPath: fields[0], serverPid: fields[1], serverStarted: fields[2],
      sessionId: fields[3], rawName: fields[4], sessionCreated: fields[5], birthMarker,
    });
    return Object.freeze({
      sessionName: fields[4], managedIncarnation: incarnation, paneId: fields[7],
      panePid: Number(fields[8]), paneTty: fields[9], cwd: fields[10],
    });
  }

  async inspectPaneDescendants(
    pane: Readonly<CodexRolloutTmuxPaneSnapshot>,
  ): Promise<readonly Readonly<CodexRolloutProcessSnapshot>[]> {
    const stdout = await execReadOnly(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm="],
      MAX_PS_OUTPUT_BYTES,
    );
    const all: CodexRolloutProcessSnapshot[] = [];
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(-?[0-9]+)\s+(\S+)\s+(.{24})\s+(.+)$/u.exec(line);
      if (match === null) throw sourceError("INSPECTION_FAILED");
      all.push(Object.freeze({
        pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]),
        foregroundProcessGroupId: Number(match[4]), tty: match[5], startToken: match[6],
        executablePath: match[7], trustedExecutable: match[7] === this.#trusted.path,
      }));
    }
    const byPid = new Map(all.map((record) => [record.pid, record]));
    const descendsFrom = (record: CodexRolloutProcessSnapshot, rootPid: number): boolean => {
      const seen = new Set<number>();
      let current: CodexRolloutProcessSnapshot | undefined = record;
      while (current !== undefined && !seen.has(current.pid)) {
        if (current.pid === rootPid) return true;
        seen.add(current.pid);
        current = byPid.get(current.parentPid);
      }
      return false;
    };
    const descendants = all.filter((record) => (
      descendsFrom(record, pane.panePid) && !descendsFrom(record, process.pid)
    )).sort((left, right) => left.pid - right.pid);
    return Object.freeze(descendants);
  }

  async inspectOpenFiles(pid: number): Promise<Readonly<CodexRolloutOpenFilesSnapshot>> {
    const stdout = await execReadOnly(
      "/usr/sbin/lsof",
      ["-n", "-P", "-a", "-p", String(pid), "-F0fatDin"],
      MAX_LSOF_OUTPUT_BYTES,
    );
    const records = parseLsof(stdout, pid);
    const trustedExecutableVnode = records.some((record) => {
      if (record.fd !== "txt" || record.type !== "REG" || record.name !== this.#trusted.path) return false;
      try {
        return BigInt(record.device) === this.#trusted.device && BigInt(record.inode) === this.#trusted.inode;
      } catch {
        return false;
      }
    });
    const paths = records.filter((record) => record.type === "REG" && isAbsolute(record.name))
      .map((record) => record.name);
    return Object.freeze({ pid, trustedExecutableVnode, paths: Object.freeze(paths) });
  }

  async openNoFollow(path: string): Promise<CodexRolloutOpenFileHandle> {
    const handle = await fsPromises.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    return new DarwinOpenRolloutHandle(path, handle);
  }
}

const DARWIN_ADAPTER_TOKEN = Symbol("DarwinCodexRolloutInspectionAdapter");

export async function createDarwinCodexRolloutInspectionAdapter(
  input: Readonly<DarwinCodexRolloutInspectionAdapterInput>,
): Promise<DarwinCodexRolloutInspectionAdapter> {
  if (process.platform !== "darwin") throw sourceError("INVALID_OPTIONS");
  const fields = exactObject(input, [
    "tmuxExecutablePath", "trustedCodexExecutablePath", "trustedCodexExecutableSha256",
  ], "INVALID_OPTIONS");
  const tmuxPath = absolutePath(fields.tmuxExecutablePath, "INVALID_OPTIONS");
  const trustedPath = absolutePath(fields.trustedCodexExecutablePath, "INVALID_OPTIONS");
  const trusted = await captureTrustedExecutable(trustedPath, exactSha256(fields.trustedCodexExecutableSha256));
  return new DarwinCodexRolloutInspectionAdapter(DARWIN_ADAPTER_TOKEN, tmuxPath, trusted);
}
