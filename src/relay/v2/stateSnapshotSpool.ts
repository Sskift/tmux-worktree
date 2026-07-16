import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import type {
  RelayV2MaterializedStateCut,
  RelayV2MaterializedStateCutAdmissionEstimate,
  RelayV2MaterializedStateCutRecord,
  RelayV2MaterializedStateCutSource,
} from "./resourceState.js";
import { canonicalizeRelayV2MaterializedJson as canonicalizeSnapshotJson } from "./resourceState.js";

const SPOOL_VERSION = 1 as const;
const LEASE_VERSION = 1 as const;
const RESERVATION_VERSION = 1 as const;
const TOMBSTONE_VERSION = 1 as const;
const OWNER_VERSION = 1 as const;
const LOCK_VERSION = 2 as const;
const MANIFEST_FILE = "manifest-v1.json";
const BINDING_FILE = "binding-v1.json";
const LEASE_FILE = "lease-v1.json";
const OWNER_FILE = "owner-v1.json";
const LOCK_FILE = ".metadata-lock-v2.json";
const LOCK_CANDIDATES_DIRECTORY = ".metadata-lock-candidates-v1";
const LOCK_QUARANTINE_DIRECTORY = ".metadata-lock-quarantine-v1";
const LEASE_METADATA_ALLOWANCE_BYTES = 256;
const RELEASE_TOMBSTONE_METADATA_HEADROOM_BYTES = 16_384;
const CONSERVATIVE_METADATA_RESERVATION_BYTES = 1_000_000;
const COORDINATION_METADATA_ALLOWANCE_BYTES = 524_288;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 5;
const MAX_ROOT_ENTRIES = 16;
const MAX_LOCK_CANDIDATES = 1_024;
const MAX_LOCK_QUARANTINES = 1_024;
const MAX_TOMBSTONES = 16_384;

export interface RelayV2StateSnapshotLimits {
  maxChunkRecords: number;
  maxChunkCanonicalBytes: number;
  maxCutRecords: number;
  maxCutCanonicalBytes: number;
  idleLeaseMs: number;
  absoluteLeaseMs: number;
  maxCutsPerPrincipal: number;
  maxCutsPerHost: number;
  maxSpoolCanonicalBytes: number;
  maxMetadataBytes: number;
  maxTombstones: number;
  releaseTombstoneMs: number;
}

export const RELAY_V2_STATE_SNAPSHOT_LIMITS: Readonly<RelayV2StateSnapshotLimits> = Object.freeze({
  maxChunkRecords: 256,
  maxChunkCanonicalBytes: 524_288,
  maxCutRecords: 100_000,
  maxCutCanonicalBytes: 268_435_456,
  idleLeaseMs: 300_000,
  absoluteLeaseMs: 3_600_000,
  maxCutsPerPrincipal: 2,
  maxCutsPerHost: 16,
  maxSpoolCanonicalBytes: 536_870_912,
  maxMetadataBytes: 16_777_216,
  maxTombstones: MAX_TOMBSTONES,
  releaseTombstoneMs: 600_000,
});

type SnapshotLimits = RelayV2StateSnapshotLimits;

export interface RelayV2StateSnapshotSpoolPaths {
  root: string;
  cuts: string;
  staging: string;
  reservations: string;
  tombstones: string;
  owner: string;
  lock: string;
  lockCandidates: string;
  lockQuarantine: string;
}

export interface RelayV2StateSnapshotSpoolTestHooks {
  beforeDirectoryFsync?: (
    point: "publish_cuts" | "publish_staging" | "rollback_cuts" | "rollback_staging",
  ) => void;
  afterChunkWrite?: (index: number) => void;
  afterMetadataLockAcquired?: (token: string) => void | Promise<void>;
  beforeStaleLockQuarantine?: (identity: string) => void | Promise<void>;
  afterStaleLockQuarantinePersisted?: (identity: string) => void;
  beforeMetadataLockRelease?: (token: string) => void | Promise<void>;
  beforeRecoveryChunkRead?: (index: number) => void;
  beforeRecoveryMetadataRead?: (
    kind: "binding" | "lease" | "manifest" | "reservation" | "tombstone",
  ) => void;
  processIncarnationForPid?: (pid: number) => string | null | undefined;
  afterRecoveryExpiredFencePersisted?: (snapshotId: string) => void;
  afterReservationPersisted?: (snapshotId: string) => void;
  /** Narrow seam for boot-bound process-witness behavior; production must omit it. */
  bootSessionIdentity?: (platform: NodeJS.Platform) => string | undefined;
  afterTombstonePersisted?: (
    snapshotId: string,
    disposition: "released" | "expired",
  ) => void;
}

export interface RelayV2StateSnapshotSpoolOptions {
  hostId: string;
  cutSource: RelayV2MaterializedStateCutSource;
  home?: string;
  root?: string;
  now?: () => number;
  /** Future composition passes its hostInstanceId; defaults to a fresh process owner ID. */
  ownerInstanceId?: string;
  /** Required when a still-live superseded owner must be durably fenced. */
  takeoverExistingOwner?: boolean;
  /** Tests may only shrink production-frozen boundaries. */
  testLimits?: Partial<SnapshotLimits>;
  /** Deterministic fault injection only; production composition must omit it. */
  testHooks?: RelayV2StateSnapshotSpoolTestHooks;
}

export interface RelayV2StateSnapshotGet {
  principalId: string;
  clientInstanceId: string;
  expectedHostEpoch: string;
  snapshotRequestId: string;
  snapshotId: string | null;
  cursor: string | null;
  nextChunkIndex: number;
}

export interface RelayV2StateSnapshotChunk {
  hostEpoch: string;
  coverageComplete: true;
  snapshotRequestId: string;
  snapshotId: string;
  snapshotCreatedAtMs: number;
  snapshotLeaseExpiresAtMs: number;
  snapshotAbsoluteExpiresAtMs: number;
  chunkIndex: number;
  isLast: boolean;
  nextCursor: string | null;
  throughEventSeq: string;
  scopesRevision: string;
  totalRecords: number;
  totalCanonicalBytes: number;
  cutDigest: string;
  records: RelayV2MaterializedStateCutRecord[];
}

export interface RelayV2StateSnapshotRelease {
  principalId: string;
  clientInstanceId: string;
  expectedHostEpoch: string;
  snapshotRequestId: string;
  snapshotId: string;
  reason: "completed" | "abandoned";
}

export interface RelayV2StateSnapshotReleased {
  hostEpoch: string;
  snapshotRequestId: string;
  snapshotId: string;
  released: boolean;
  alreadyReleased: boolean;
  releasedAtMs: number;
}

export type RelayV2StateSnapshotSpoolErrorCode =
  | "BUSY"
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_EPOCH_MISMATCH"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "SNAPSHOT_EXPIRED";

const RELAY_V2_STATE_SNAPSHOT_SPOOL_ERROR = Symbol.for(
  "tmux-worktree.relay-v2.state-snapshot-spool-error",
);

const RELAY_V2_STATE_SNAPSHOT_SPOOL_ERROR_CODES: ReadonlySet<string> = new Set([
  "BUSY",
  "CAPABILITY_UNAVAILABLE",
  "HOST_EPOCH_MISMATCH",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "SNAPSHOT_EXPIRED",
]);

export class RelayV2StateSnapshotSpoolError extends Error {
  readonly [RELAY_V2_STATE_SNAPSHOT_SPOOL_ERROR] = true;

  constructor(
    readonly code: RelayV2StateSnapshotSpoolErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RelayV2StateSnapshotSpoolError";
  }
}

/** Recognizes only spool-owned errors across independently bundled entries. */
export function isRelayV2StateSnapshotSpoolError(
  error: unknown,
): error is RelayV2StateSnapshotSpoolError {
  if (!(error instanceof Error)
    || error.name !== "RelayV2StateSnapshotSpoolError"
    || (error as Record<PropertyKey, unknown>)[RELAY_V2_STATE_SNAPSHOT_SPOOL_ERROR] !== true
    || !RELAY_V2_STATE_SNAPSHOT_SPOOL_ERROR_CODES.has(
      (error as { code?: unknown }).code as string,
    )) return false;
  const details = (error as { details?: unknown }).details;
  return details === null
    || (!!details && typeof details === "object" && !Array.isArray(details));
}

interface SnapshotBinding {
  principalId: string;
  clientInstanceId: string;
  hostEpoch: string;
  snapshotRequestId: string;
}

interface PersistedChunkIndex {
  index: number;
  file: string;
  recordCount: number;
  canonicalBytes: number;
  digest: string;
  nextCursor: string | null;
}

interface PersistedManifest {
  version: typeof SPOOL_VERSION;
  snapshotId: string;
  hostId: string;
  binding: SnapshotBinding;
  snapshotCreatedAtMs: number;
  snapshotAbsoluteExpiresAtMs: number;
  throughEventSeq: string;
  scopesRevision: string;
  totalRecords: number;
  totalCanonicalBytes: number;
  cutDigest: string;
  metadataBytes: number;
  chunks: PersistedChunkIndex[];
}

interface PersistedLease {
  version: typeof LEASE_VERSION;
  snapshotId: string;
  snapshotLeaseExpiresAtMs: number;
}

interface PersistedBindingMarker {
  version: typeof SPOOL_VERSION;
  snapshotId: string;
  hostId: string;
  binding: SnapshotBinding;
  snapshotAbsoluteExpiresAtMs: number;
}

interface PersistedReservation {
  version: typeof RESERVATION_VERSION;
  reservationId: string;
  snapshotId: string;
  hostId: string;
  ownerFence: string;
  binding: SnapshotBinding;
  snapshotCreatedAtMs: number;
  snapshotAbsoluteExpiresAtMs: number;
  reservedRecords: number;
  reservedCanonicalBytes: number;
  reservedMetadataBytes: number;
}

interface PersistedSnapshotTombstone {
  version: typeof TOMBSTONE_VERSION;
  snapshotId: string;
  hostId: string;
  binding: SnapshotBinding;
  disposition: "released" | "expired";
  recordedAtMs: number;
  expiresAtMs: number;
  metadataBytes: number;
}

interface PersistedSpoolOwner {
  version: typeof OWNER_VERSION;
  hostId: string;
  ownerInstanceId: string;
  fence: string;
  acquiredAtMs: number;
  pid: number;
  processIncarnation: string;
}

interface PersistedLockHolder {
  version: typeof LOCK_VERSION;
  token: string;
  pid: number;
  processIncarnation: string;
}

interface ActiveCut {
  directory: string;
  manifest: PersistedManifest;
  lease: PersistedLease;
}

interface SnapshotTombstone {
  path: string;
  record: PersistedSnapshotTombstone;
}

interface BuildEntry {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type FirstDecision =
  | { kind: "active"; cut: ActiveCut }
  | { kind: "wait"; build: BuildEntry }
  | { kind: "build"; reservation: PersistedReservation; build: BuildEntry };

export function relayV2StateSnapshotSpoolPaths(
  home = homedir(),
): RelayV2StateSnapshotSpoolPaths {
  const root = join(home, ".tmux-worktree", "relay-v2-state-snapshot-spool-v1");
  return pathsFromRoot(root);
}

function pathsFromRoot(root: string): RelayV2StateSnapshotSpoolPaths {
  return {
    root,
    cuts: join(root, "cuts"),
    staging: join(root, "staging"),
    reservations: join(root, "reservations"),
    tombstones: join(root, "tombstones"),
    owner: join(root, OWNER_FILE),
    lock: join(root, LOCK_FILE),
    lockCandidates: join(root, LOCK_CANDIDATES_DIRECTORY),
    lockQuarantine: join(root, LOCK_QUARANTINE_DIRECTORY),
  };
}

function physicalCustomRoot(root: string): { root: string; trustedBoundary: string } {
  const lexicalRoot = resolve(root);
  const rootName = basename(lexicalRoot);
  if (rootName.length === 0) {
    throw new UnsafeSpoolPathError("snapshot spool custom root is invalid");
  }
  const missingParents: string[] = [];
  let existingParent = dirname(lexicalRoot);
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) {
      throw new UnsafeSpoolPathError("snapshot spool custom root has no trusted parent");
    }
    missingParents.unshift(basename(existingParent));
    existingParent = parent;
  }
  const trustedBoundary = realpathSync(existingParent);
  const physicalParent = missingParents.reduce(
    (parent, segment) => join(parent, segment),
    trustedBoundary,
  );
  return {
    root: join(physicalParent, rootName),
    trustedBoundary,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class UnsafeSpoolPathError extends Error {}

class LineageOperationError {
  constructor(readonly cause: unknown) {}
}

function assertOwnedDirectory(path: string, requirePrivate: boolean): void {
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)
    || (requirePrivate && (metadata.mode & 0o777) !== 0o700)) {
    throw new UnsafeSpoolPathError("snapshot spool directory trust check failed");
  }
}

function assertNoSymlinkAncestors(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const segment of absolute.slice(root.length).split("/").filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    const metadata = lstatSync(cursor);
    if (metadata.isSymbolicLink()) {
      throw new UnsafeSpoolPathError("snapshot spool ancestor trust check failed");
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assertOwnedDirectory(path, true);
}

function ensurePrivateTree(target: string, boundary: string): void {
  const absoluteTarget = resolve(target);
  const absoluteBoundary = resolve(boundary);
  if (!isAbsolute(absoluteTarget)
    || (absoluteTarget !== absoluteBoundary
      && !absoluteTarget.startsWith(`${absoluteBoundary}/`))) {
    throw new UnsafeSpoolPathError("snapshot spool escaped its trusted boundary");
  }
  const missing: string[] = [];
  let cursor = absoluteTarget;
  while (cursor !== absoluteBoundary) {
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new UnsafeSpoolPathError("snapshot spool boundary is invalid");
    }
    cursor = parent;
  }
  for (const directory of missing.reverse()) ensurePrivateDirectory(directory);
}

function ensureSpoolDirectories(
  paths: RelayV2StateSnapshotSpoolPaths,
  trustedBoundary: string,
  verifyTrustedAncestors: boolean,
): void {
  if (verifyTrustedAncestors) assertNoSymlinkAncestors(trustedBoundary);
  assertOwnedDirectory(trustedBoundary, false);
  if ((lstatSync(trustedBoundary).mode & 0o022) !== 0) {
    throw new UnsafeSpoolPathError("snapshot spool trusted boundary is writable by another user");
  }
  ensurePrivateTree(paths.root, trustedBoundary);
  ensurePrivateDirectory(paths.cuts);
  ensurePrivateDirectory(paths.staging);
  ensurePrivateDirectory(paths.reservations);
  ensurePrivateDirectory(paths.tombstones);
  ensurePrivateDirectory(paths.lockCandidates);
  ensurePrivateDirectory(paths.lockQuarantine);
}

function fsyncDirectory(path: string): void {
  let descriptor = -1;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function writeAll(descriptor: number, contents: Buffer): void {
  let offset = 0;
  while (offset < contents.byteLength) {
    offset += writeSync(
      descriptor,
      contents,
      offset,
      contents.byteLength - offset,
      offset,
    );
  }
}

function writePrivateFile(path: string, contents: Buffer): void {
  assertOwnedDirectory(dirname(path), true);
  let descriptor = -1;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeAll(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}

function atomicWritePrivateFile(path: string, contents: Buffer): void {
  const directory = dirname(path);
  assertOwnedDirectory(directory, true);
  if (existsSync(path)) assertPrivateFile(path, Number.MAX_SAFE_INTEGER);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writePrivateFile(temporary, contents);
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readPrivateFile(path: string, maxBytes: number): Buffer {
  assertPrivateFile(path, maxBytes);
  return readFileSync(path);
}

function assertPrivateFile(path: string, maxBytes: number): void {
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)
    || metadata.size > maxBytes
    || (metadata.mode & 0o777) !== 0o600) {
    throw new UnsafeSpoolPathError("snapshot spool file trust check failed");
  }
}

function assertWithinBoundary(path: string, boundary: string): void {
  const absolutePath = resolve(path);
  const absoluteBoundary = resolve(boundary);
  if (absolutePath !== absoluteBoundary
    && !absolutePath.startsWith(`${absoluteBoundary}/`)) {
    throw new UnsafeSpoolPathError("snapshot spool path escaped its trusted boundary");
  }
}

function validateEntryName(name: string, label: string): void {
  if (name.length === 0
    || Buffer.byteLength(name, "utf8") > 255
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\0")) {
    throw new UnsafeSpoolPathError(`snapshot spool ${label} name is invalid`);
  }
}

function visitDirectoryBounded(
  path: string,
  maxEntries: number,
  visitor: (name: string) => boolean | void,
): { count: number; complete: boolean } {
  assertOwnedDirectory(path, true);
  const directory = opendirSync(path);
  let count = 0;
  let complete = true;
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      count += 1;
      if (count > maxEntries) {
        throw new Error("snapshot spool directory entry limit exceeded");
      }
      validateEntryName(entry.name, "directory entry");
      if (visitor(entry.name) === false) {
        complete = false;
        break;
      }
    }
  } finally {
    directory.closeSync();
  }
  return { count, complete };
}

function assertPrivateFlatDirectory(
  path: string,
  boundary: string,
  maxEntries: number,
  maxFileBytes: number,
): void {
  assertWithinBoundary(path, boundary);
  assertOwnedDirectory(path, true);
  visitDirectoryBounded(path, maxEntries, (entry) => {
    const child = join(path, entry);
    assertWithinBoundary(child, boundary);
    assertPrivateFile(child, maxFileBytes);
  });
}

function jsonFile(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function readCanonicalPrivateFile<T>(
  path: string,
  maxBytes: number,
  parser: (value: unknown) => T,
): { record: T; actualBytes: number } {
  const contents = readPrivateFile(path, maxBytes);
  const record = parser(JSON.parse(contents.toString("utf8")));
  if (!contents.equals(jsonFile(record))) {
    throw new Error("snapshot metadata is not in its canonical persisted form");
  }
  return { record, actualBytes: contents.byteLength };
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function assertOpaqueId(value: unknown, label: string, maxBytes = 128): asserts value is string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || value.includes("\0")) {
    throw new RelayV2StateSnapshotSpoolError("INVALID_ARGUMENT", `${label} is invalid`);
  }
}

function assertSafeTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid snapshot ${label}`);
  }
}

function assertCanonicalCounter(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`invalid snapshot ${label}`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, "base64url").toString("base64url") !== value) {
    throw new Error(`invalid snapshot ${label}`);
  }
}

function bindingFor(request: {
  principalId: string;
  clientInstanceId: string;
  expectedHostEpoch: string;
  snapshotRequestId: string;
}): SnapshotBinding {
  return {
    principalId: request.principalId,
    clientInstanceId: request.clientInstanceId,
    hostEpoch: request.expectedHostEpoch,
    snapshotRequestId: request.snapshotRequestId,
  };
}

function validateBinding(binding: SnapshotBinding): void {
  assertOpaqueId(binding.principalId, "principalId");
  assertOpaqueId(binding.clientInstanceId, "clientInstanceId");
  assertOpaqueId(binding.hostEpoch, "hostEpoch");
  assertOpaqueId(binding.snapshotRequestId, "snapshotRequestId");
}

function sameBinding(left: SnapshotBinding, right: SnapshotBinding): boolean {
  return left.principalId === right.principalId
    && left.clientInstanceId === right.clientInstanceId
    && left.hostEpoch === right.hostEpoch
    && left.snapshotRequestId === right.snapshotRequestId;
}

function logicalKey(binding: SnapshotBinding): string {
  return canonicalizeSnapshotJson(binding);
}

function validateGet(request: RelayV2StateSnapshotGet): void {
  validateBinding(bindingFor(request));
  if (request.snapshotId !== null) assertOpaqueId(request.snapshotId, "snapshotId");
  if (request.cursor !== null) assertOpaqueId(request.cursor, "cursor", 1_024);
  if (!Number.isSafeInteger(request.nextChunkIndex) || request.nextChunkIndex < 0) {
    throw new RelayV2StateSnapshotSpoolError(
      "INVALID_ARGUMENT",
      "nextChunkIndex is invalid",
    );
  }
  if (request.snapshotId === null
    && (request.cursor !== null || request.nextChunkIndex !== 0)) {
    throw new RelayV2StateSnapshotSpoolError(
      "INVALID_ARGUMENT",
      "first snapshot request must start at chunk zero without a cursor",
    );
  }
}

function validateRelease(request: RelayV2StateSnapshotRelease): void {
  validateBinding(bindingFor(request));
  assertOpaqueId(request.snapshotId, "snapshotId");
  if (request.reason !== "completed" && request.reason !== "abandoned") {
    throw new RelayV2StateSnapshotSpoolError("INVALID_ARGUMENT", "release reason is invalid");
  }
}

interface RecordOrderState {
  currentScope: string | null;
  lastScope: string | null;
  lastSession: string | null;
  sawSessionsScope: boolean;
}

function newRecordOrderState(): RecordOrderState {
  return {
    currentScope: null,
    lastScope: null,
    lastSession: null,
    sawSessionsScope: false,
  };
}

function acceptRecordOrder(
  state: RecordOrderState,
  record: RelayV2MaterializedStateCutRecord,
): void {
    if (!isRecord(record) || typeof record.recordType !== "string") {
      throw new Error("materialized snapshot record is malformed");
    }
    if (record.recordType === "scope") {
      if (!exactKeys(record, ["recordType", "item"])
        || !isRecord(record.item)
        || typeof record.item.scopeId !== "string"
        || (state.currentScope !== null && !state.sawSessionsScope)
        || (state.lastScope !== null
          && utf8Compare(state.lastScope, record.item.scopeId) >= 0)) {
        throw new Error("materialized scope record order is invalid");
      }
      state.currentScope = record.item.scopeId;
      state.lastScope = state.currentScope;
      state.lastSession = null;
      state.sawSessionsScope = false;
    } else if (record.recordType === "sessions_scope") {
      if (!exactKeys(record, [
        "recordType", "scopeId", "revision", "completeness",
      ])
        || state.currentScope === null
        || state.sawSessionsScope
        || record.scopeId !== state.currentScope
        || record.completeness !== "complete") {
        throw new Error("materialized sessions_scope record order is invalid");
      }
      assertCanonicalCounter(record.revision, "sessions revision");
      state.sawSessionsScope = true;
    } else if (record.recordType === "session") {
      if (!exactKeys(record, ["recordType", "scopeId", "item"])
        || state.currentScope === null
        || !state.sawSessionsScope
        || record.scopeId !== state.currentScope
        || !isRecord(record.item)
        || record.item.scopeId !== state.currentScope
        || typeof record.item.sessionId !== "string"
        || (state.lastSession !== null
          && utf8Compare(state.lastSession, record.item.sessionId) >= 0)) {
        throw new Error("materialized Session record order is invalid");
      }
      state.lastSession = record.item.sessionId;
    } else {
      throw new Error("materialized snapshot record type is invalid");
    }
    canonicalizeSnapshotJson(record);
}

function finishRecordOrder(state: RecordOrderState): void {
  if (state.currentScope !== null && !state.sawSessionsScope) {
    throw new Error("materialized scope is missing its sessions_scope record");
  }
}

function validateRecordStream(records: readonly RelayV2MaterializedStateCutRecord[]): void {
  if (!Array.isArray(records)) throw new Error("materialized snapshot records are invalid");
  const state = newRecordOrderState();
  for (const record of records) {
    acceptRecordOrder(state, record);
  }
  finishRecordOrder(state);
}

function expiredError(): RelayV2StateSnapshotSpoolError {
  return new RelayV2StateSnapshotSpoolError(
    "SNAPSHOT_EXPIRED",
    "snapshot is unavailable or expired",
  );
}

function structuredSpoolError(error: unknown): RelayV2StateSnapshotSpoolError {
  if (isRelayV2StateSnapshotSpoolError(error)) return error;
  return new RelayV2StateSnapshotSpoolError(
    "INTERNAL",
    "snapshot spool persistence failed closed",
  );
}

function ownerFencedError(): RelayV2StateSnapshotSpoolError {
  return new RelayV2StateSnapshotSpoolError(
    "INTERNAL",
    "snapshot spool owner is no longer active",
  );
}

function mapSourceError(error: unknown): RelayV2StateSnapshotSpoolError {
  if (isRecord(error) && typeof error.code === "string") {
    const code = error.code;
    const messages: Partial<Record<RelayV2StateSnapshotSpoolErrorCode, string>> = {
      BUSY: "materialized snapshot source is busy",
      CAPABILITY_UNAVAILABLE: "materialized snapshot source is unavailable",
      HOST_EPOCH_MISMATCH: "materialized snapshot source changed host lineage",
      INTERNAL: "materialized snapshot source failed",
      INVALID_ARGUMENT: "materialized snapshot source rejected the request",
    };
    if (Object.hasOwn(messages, code)) {
      return new RelayV2StateSnapshotSpoolError(
        code as RelayV2StateSnapshotSpoolErrorCode,
        messages[code as RelayV2StateSnapshotSpoolErrorCode]!,
        null,
      );
    }
  }
  return new RelayV2StateSnapshotSpoolError(
    "INTERNAL",
    "materialized snapshot source failed",
  );
}

function newSnapshotId(): string {
  return `snap_${randomBytes(32).toString("base64url")}`;
}

function newReservationId(): string {
  return `build_${randomBytes(24).toString("base64url")}`;
}

function newCursor(): string {
  return randomBytes(32).toString("base64url");
}

function chunkFilename(index: number): string {
  return `chunk-${String(index).padStart(6, "0")}.json`;
}

function isAtomicTemporaryName(name: string): boolean {
  return /^\..+\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/.test(name);
}

function metadataBytesForManifest(manifest: PersistedManifest): number {
  let measured = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = { ...manifest, metadataBytes: measured };
    const next = jsonFile(candidate).byteLength
      + jsonFile(bindingMarkerFor(candidate)).byteLength
      + LEASE_METADATA_ALLOWANCE_BYTES
      + RELEASE_TOMBSTONE_METADATA_HEADROOM_BYTES;
    if (next === measured) return next;
    measured = next;
  }
  return measured;
}

function bindingMarkerFor(manifest: PersistedManifest): PersistedBindingMarker {
  return {
    version: SPOOL_VERSION,
    snapshotId: manifest.snapshotId,
    hostId: manifest.hostId,
    binding: clone(manifest.binding),
    snapshotAbsoluteExpiresAtMs: manifest.snapshotAbsoluteExpiresAtMs,
  };
}

function bindingMarkerForReservation(
  reservation: PersistedReservation,
): PersistedBindingMarker {
  return {
    version: SPOOL_VERSION,
    snapshotId: reservation.snapshotId,
    hostId: reservation.hostId,
    binding: clone(reservation.binding),
    snapshotAbsoluteExpiresAtMs: reservation.snapshotAbsoluteExpiresAtMs,
  };
}

function metadataBytesForTombstone(
  record: PersistedSnapshotTombstone,
): number {
  let measured = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = jsonFile({ ...record, metadataBytes: measured }).byteLength;
    if (next === measured) return next;
    measured = next;
  }
  return measured;
}

function parseBinding(value: unknown): SnapshotBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "principalId", "clientInstanceId", "hostEpoch", "snapshotRequestId",
  ])) throw new Error("snapshot binding is malformed");
  const binding = value as unknown as SnapshotBinding;
  validateBinding(binding);
  return {
    principalId: binding.principalId,
    clientInstanceId: binding.clientInstanceId,
    hostEpoch: binding.hostEpoch,
    snapshotRequestId: binding.snapshotRequestId,
  };
}

function parseManifest(value: unknown): PersistedManifest {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "snapshotId", "hostId", "binding", "snapshotCreatedAtMs",
    "snapshotAbsoluteExpiresAtMs", "throughEventSeq", "scopesRevision",
    "totalRecords", "totalCanonicalBytes", "cutDigest", "metadataBytes", "chunks",
  ]) || value.version !== SPOOL_VERSION || !Array.isArray(value.chunks)) {
    throw new Error("snapshot manifest is malformed");
  }
  assertOpaqueId(value.snapshotId, "snapshotId");
  assertOpaqueId(value.hostId, "hostId");
  const binding = parseBinding(value.binding);
  assertSafeTimestamp(value.snapshotCreatedAtMs, "createdAt");
  assertSafeTimestamp(value.snapshotAbsoluteExpiresAtMs, "absolute expiry");
  assertCanonicalCounter(value.throughEventSeq, "throughEventSeq");
  assertCanonicalCounter(value.scopesRevision, "scopesRevision");
  for (const field of ["totalRecords", "totalCanonicalBytes", "metadataBytes"] as const) {
    if (typeof value[field] !== "number"
      || !Number.isSafeInteger(value[field])
      || value[field] < 0) {
      throw new Error(`snapshot manifest ${field} is invalid`);
    }
  }
  const totalRecords = value.totalRecords as number;
  const totalCanonicalBytes = value.totalCanonicalBytes as number;
  const metadataBytes = value.metadataBytes as number;
  assertDigest(value.cutDigest, "cut digest");
  if (value.snapshotAbsoluteExpiresAtMs <= value.snapshotCreatedAtMs
    || value.chunks.length === 0) {
    throw new Error("snapshot manifest lifetime or chunks are invalid");
  }
  const rawChunks = value.chunks;
  const chunks = rawChunks.map((chunk, index) => {
    if (!isRecord(chunk) || !exactKeys(chunk, [
      "index", "file", "recordCount", "canonicalBytes", "digest", "nextCursor",
    ])
      || chunk.index !== index
      || chunk.file !== chunkFilename(index)
      || typeof chunk.recordCount !== "number"
      || !Number.isSafeInteger(chunk.recordCount)
      || chunk.recordCount < 0
      || typeof chunk.canonicalBytes !== "number"
      || !Number.isSafeInteger(chunk.canonicalBytes)
      || chunk.canonicalBytes < 2) {
      throw new Error("snapshot chunk index is malformed");
    }
    assertDigest(chunk.digest, "chunk digest");
    if (index === rawChunks.length - 1) {
      if (chunk.nextCursor !== null) throw new Error("last snapshot chunk has a cursor");
    } else {
      assertOpaqueId(chunk.nextCursor, "nextCursor", 1_024);
    }
    return {
      index: chunk.index,
      file: chunk.file,
      recordCount: chunk.recordCount,
      canonicalBytes: chunk.canonicalBytes,
      digest: chunk.digest,
      nextCursor: chunk.nextCursor,
    };
  });
  return {
    version: SPOOL_VERSION,
    snapshotId: value.snapshotId,
    hostId: value.hostId,
    binding,
    snapshotCreatedAtMs: value.snapshotCreatedAtMs,
    snapshotAbsoluteExpiresAtMs: value.snapshotAbsoluteExpiresAtMs,
    throughEventSeq: value.throughEventSeq,
    scopesRevision: value.scopesRevision,
    totalRecords,
    totalCanonicalBytes,
    cutDigest: value.cutDigest,
    metadataBytes,
    chunks,
  };
}

function parseLease(value: unknown, manifest: PersistedManifest): PersistedLease {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "snapshotId", "snapshotLeaseExpiresAtMs",
  ]) || value.version !== LEASE_VERSION || value.snapshotId !== manifest.snapshotId) {
    throw new Error("snapshot lease is malformed");
  }
  assertSafeTimestamp(value.snapshotLeaseExpiresAtMs, "idle expiry");
  if (value.snapshotLeaseExpiresAtMs > manifest.snapshotAbsoluteExpiresAtMs) {
    throw new Error("snapshot idle lease exceeds absolute expiry");
  }
  return {
    version: LEASE_VERSION,
    snapshotId: value.snapshotId,
    snapshotLeaseExpiresAtMs: value.snapshotLeaseExpiresAtMs,
  };
}

function parseBindingMarker(value: unknown): PersistedBindingMarker {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "snapshotId", "hostId", "binding", "snapshotAbsoluteExpiresAtMs",
  ]) || value.version !== SPOOL_VERSION) {
    throw new Error("snapshot binding marker is malformed");
  }
  assertOpaqueId(value.snapshotId, "snapshotId");
  assertOpaqueId(value.hostId, "hostId");
  const binding = parseBinding(value.binding);
  assertSafeTimestamp(value.snapshotAbsoluteExpiresAtMs, "absolute expiry");
  return {
    version: SPOOL_VERSION,
    snapshotId: value.snapshotId,
    hostId: value.hostId,
    binding,
    snapshotAbsoluteExpiresAtMs: value.snapshotAbsoluteExpiresAtMs,
  };
}

function parseTombstone(value: unknown): PersistedSnapshotTombstone {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "snapshotId", "hostId", "binding", "disposition", "recordedAtMs",
    "expiresAtMs", "metadataBytes",
  ]) || value.version !== TOMBSTONE_VERSION) {
    throw new Error("snapshot tombstone is malformed");
  }
  assertOpaqueId(value.snapshotId, "snapshotId");
  assertOpaqueId(value.hostId, "hostId");
  const binding = parseBinding(value.binding);
  if (value.disposition !== "released" && value.disposition !== "expired") {
    throw new Error("snapshot tombstone disposition is invalid");
  }
  assertSafeTimestamp(value.recordedAtMs, "tombstone time");
  assertSafeTimestamp(value.expiresAtMs, "tombstone expiry");
  if (typeof value.metadataBytes !== "number"
    || !Number.isSafeInteger(value.metadataBytes) || value.metadataBytes <= 0
    || value.expiresAtMs <= value.recordedAtMs) {
    throw new Error("snapshot release tombstone fields are invalid");
  }
  return {
    version: TOMBSTONE_VERSION,
    snapshotId: value.snapshotId,
    hostId: value.hostId,
    binding,
    disposition: value.disposition,
    recordedAtMs: value.recordedAtMs,
    expiresAtMs: value.expiresAtMs,
    metadataBytes: value.metadataBytes,
  };
}

function parseReservation(value: unknown): PersistedReservation {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "reservationId", "snapshotId", "hostId", "ownerFence", "binding",
    "snapshotCreatedAtMs", "snapshotAbsoluteExpiresAtMs", "reservedRecords",
    "reservedCanonicalBytes", "reservedMetadataBytes",
  ]) || value.version !== RESERVATION_VERSION) {
    throw new Error("snapshot reservation is malformed");
  }
  assertOpaqueId(value.reservationId, "reservationId");
  assertOpaqueId(value.snapshotId, "snapshotId");
  assertOpaqueId(value.hostId, "hostId");
  assertOpaqueId(value.ownerFence, "ownerFence");
  const binding = parseBinding(value.binding);
  assertSafeTimestamp(value.snapshotCreatedAtMs, "createdAt");
  assertSafeTimestamp(value.snapshotAbsoluteExpiresAtMs, "absolute expiry");
  if (typeof value.reservedRecords !== "number"
    || !Number.isSafeInteger(value.reservedRecords)
    || value.reservedRecords < 0
    || typeof value.reservedCanonicalBytes !== "number"
    || !Number.isSafeInteger(value.reservedCanonicalBytes)
    || value.reservedCanonicalBytes <= 0
    || typeof value.reservedMetadataBytes !== "number"
    || !Number.isSafeInteger(value.reservedMetadataBytes)
    || value.reservedMetadataBytes <= 0) {
    throw new Error("snapshot reservation quota is invalid");
  }
  return {
    version: RESERVATION_VERSION,
    reservationId: value.reservationId,
    snapshotId: value.snapshotId,
    hostId: value.hostId,
    ownerFence: value.ownerFence,
    binding,
    snapshotCreatedAtMs: value.snapshotCreatedAtMs,
    snapshotAbsoluteExpiresAtMs: value.snapshotAbsoluteExpiresAtMs,
    reservedRecords: value.reservedRecords,
    reservedCanonicalBytes: value.reservedCanonicalBytes,
    reservedMetadataBytes: value.reservedMetadataBytes,
  };
}

function parseOwner(value: unknown): PersistedSpoolOwner {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "hostId", "ownerInstanceId", "fence", "acquiredAtMs", "pid",
    "processIncarnation",
  ]) || value.version !== OWNER_VERSION) {
    throw new Error("snapshot spool owner metadata is malformed");
  }
  assertOpaqueId(value.hostId, "hostId");
  assertOpaqueId(value.ownerInstanceId, "ownerInstanceId");
  assertOpaqueId(value.fence, "ownerFence");
  assertSafeTimestamp(value.acquiredAtMs, "owner acquisition");
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("snapshot spool owner pid is malformed");
  }
  assertOpaqueId(value.processIncarnation, "processIncarnation");
  return {
    version: OWNER_VERSION,
    hostId: value.hostId,
    ownerInstanceId: value.ownerInstanceId,
    fence: value.fence,
    acquiredAtMs: value.acquiredAtMs,
    pid: value.pid,
    processIncarnation: value.processIncarnation,
  };
}

function parseLockHolder(value: unknown): PersistedLockHolder {
  if (!isRecord(value) || !exactKeys(value, [
    "version", "token", "pid", "processIncarnation",
  ])
    || value.version !== LOCK_VERSION) {
    throw new Error("snapshot spool lock metadata is malformed");
  }
  assertOpaqueId(value.token, "lockToken");
  if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new Error("snapshot spool lock pid is malformed");
  }
  assertOpaqueId(value.processIncarnation, "processIncarnation");
  return {
    version: LOCK_VERSION,
    token: value.token,
    pid: value.pid,
    processIncarnation: value.processIncarnation,
  };
}

type ProcessPresence = "present" | "absent" | "indeterminate";

const PROCESS_INCARNATION_WITNESS_VERSION = 2;
const MAX_BOOT_SESSION_ID_BYTES = 128;
const MAX_LINUX_PROCESS_STAT_BYTES = 4_096;
const MAX_PROCESS_START_OUTPUT_BYTES = 256;
const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;
const BOOT_SESSION_UUID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\r?\n)?$/i;
const MACOS_PROCESS_START_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +([1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]) ([0-9]{4})$/;
const MACOS_MONTHS = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);
const MACOS_WEEKDAYS = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3],
  ["Thu", 4], ["Fri", 5], ["Sat", 6],
]);
const PROCESS_WITNESS_ENV = Object.freeze({
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC0",
});

function processPresence(pid: number): ProcessPresence {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return "absent";
    return "indeterminate";
  }
}

function readBoundedUtf8File(path: string, maxBytes: number): string | undefined {
  const descriptor = openSync(path, "r");
  try {
    const contents = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const bytesRead = readSync(
        descriptor,
        contents,
        total,
        maxBytes + 1 - total,
        null,
      );
      if (bytesRead === 0) return contents.subarray(0, total).toString("utf8");
      total += bytesRead;
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

function canonicalBootSessionIdentity(raw: string | undefined): string | undefined {
  if (raw === undefined
    || Buffer.byteLength(raw, "utf8") > MAX_BOOT_SESSION_ID_BYTES) return undefined;
  const match = BOOT_SESSION_UUID_PATTERN.exec(raw);
  return match?.[1]?.toLowerCase();
}

function productionBootSessionIdentity(platform: NodeJS.Platform): string | undefined {
  if (platform === "linux") {
    return readBoundedUtf8File(
      "/proc/sys/kernel/random/boot_id",
      MAX_BOOT_SESSION_ID_BYTES,
    );
  }
  if (platform === "darwin") {
    return execFileSync(
      "/usr/sbin/sysctl",
      ["-n", "kern.bootsessionuuid"],
      {
        encoding: "utf8",
        env: PROCESS_WITNESS_ENV,
        maxBuffer: MAX_BOOT_SESSION_ID_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      },
    );
  }
  return undefined;
}

function linuxProcessStartTicks(pid: number): string | undefined {
  const stat = readBoundedUtf8File(`/proc/${pid}/stat`, MAX_LINUX_PROCESS_STAT_BYTES);
  if (stat === undefined) return undefined;
  const normalized = stat.endsWith("\n") ? stat.slice(0, -1) : stat;
  if (normalized.includes("\n") || normalized.includes("\r")) return undefined;
  const opening = normalized.indexOf("(");
  const closing = normalized.lastIndexOf(")");
  if (opening <= 0
    || normalized.slice(0, opening).trim() !== String(pid)
    || closing <= opening
    || normalized.slice(closing, closing + 2) !== ") ") return undefined;
  const fields = normalized.slice(closing + 2).split(" ");
  const startTicks = fields[19];
  if (fields.length < 20
    || fields.some((field) => field.length === 0)
    || startTicks === undefined
    || !/^(?:0|[1-9][0-9]{0,19})$/.test(startTicks)) return undefined;
  const numeric = BigInt(startTicks);
  if (numeric === 0n || numeric > MAX_UNSIGNED_64) return undefined;
  return startTicks;
}

function macosProcessStart(pid: number): string | undefined {
  const raw = execFileSync(
    "/bin/ps",
    ["-o", "lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      env: PROCESS_WITNESS_ENV,
      maxBuffer: MAX_PROCESS_START_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    },
  );
  if (Buffer.byteLength(raw, "utf8") > MAX_PROCESS_START_OUTPUT_BYTES) return undefined;
  const match = MACOS_PROCESS_START_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const [, weekdayName, monthName, dayText, hourText, minuteText, secondText, yearText] = match;
  const month = MACOS_MONTHS.get(monthName!);
  const weekday = MACOS_WEEKDAYS.get(weekdayName!);
  if (month === undefined || weekday === undefined) return undefined;
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const year = Number(yearText);
  if (!Number.isSafeInteger(year) || year < 1970 || year > 9_999) return undefined;
  const timestamp = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (timestamp.getUTCFullYear() !== year
    || timestamp.getUTCMonth() !== month
    || timestamp.getUTCDate() !== day
    || timestamp.getUTCHours() !== hour
    || timestamp.getUTCMinutes() !== minute
    || timestamp.getUTCSeconds() !== second
    || timestamp.getUTCDay() !== weekday) return undefined;
  return timestamp.toISOString();
}

function hashProcessIncarnation(
  platform: "linux" | "darwin",
  bootSessionIdentity: string,
  pid: number,
  processStartKind: "proc-start-ticks" | "ps-lstart-utc",
  processStart: string,
): string {
  const canonical = [
    `version=${PROCESS_INCARNATION_WITNESS_VERSION}`,
    `platform=${platform}`,
    `bootSessionIdentity=${bootSessionIdentity}`,
    `pid=${pid}`,
    `processStartKind=${processStartKind}`,
    `processStart=${processStart}`,
    "",
  ].join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("base64url");
}

function processIncarnationForPid(
  pid: number,
  bootSessionIdentity: (platform: NodeJS.Platform) => string | undefined =
    productionBootSessionIdentity,
): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const initialPresence = processPresence(pid);
  if (initialPresence === "absent") return null;
  if (initialPresence === "indeterminate") return undefined;
  try {
    if (process.platform !== "linux" && process.platform !== "darwin") return undefined;
    const bootBefore = canonicalBootSessionIdentity(bootSessionIdentity(process.platform));
    if (bootBefore === undefined) return undefined;
    const startBefore = process.platform === "linux"
      ? linuxProcessStartTicks(pid)
      : macosProcessStart(pid);
    if (startBefore === undefined) return undefined;
    const middlePresence = processPresence(pid);
    if (middlePresence === "absent") return null;
    if (middlePresence === "indeterminate") return undefined;
    const startAfter = process.platform === "linux"
      ? linuxProcessStartTicks(pid)
      : macosProcessStart(pid);
    const bootAfter = canonicalBootSessionIdentity(bootSessionIdentity(process.platform));
    if (startAfter === undefined
      || bootAfter === undefined
      || startBefore !== startAfter
      || bootBefore !== bootAfter) return undefined;
    const finalPresence = processPresence(pid);
    if (finalPresence === "absent") return null;
    if (finalPresence === "indeterminate") return undefined;
    return hashProcessIncarnation(
      process.platform,
      bootBefore,
      pid,
      process.platform === "linux" ? "proc-start-ticks" : "ps-lstart-utc",
      startBefore,
    );
  } catch {
    if (processPresence(pid) === "absent") return null;
    return undefined;
  }
}

class RecoveryMetadataQuotaError extends Error {}

interface RecoveryMetadataBudget {
  actualBytes: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class RelayV2StateSnapshotSpool {
  readonly hostId: string;
  readonly paths: RelayV2StateSnapshotSpoolPaths;
  readonly limits: Readonly<SnapshotLimits>;
  readonly ownerInstanceId: string;

  private readonly cutSource: RelayV2MaterializedStateCutSource;
  private readonly now: () => number;
  private readonly trustedBoundary: string;
  private readonly verifyTrustedAncestors: boolean;
  private readonly takeoverExistingOwner: boolean;
  private readonly testHooks: RelayV2StateSnapshotSpoolTestHooks | undefined;
  private readonly processIncarnationProbe: (pid: number) => string | null | undefined;
  private readonly processIncarnation: string;
  private readonly ownerFence = randomBytes(32).toString("base64url");
  private readonly activeById = new Map<string, ActiveCut>();
  private readonly activeByLogicalKey = new Map<string, ActiveCut>();
  private readonly reservationsById = new Map<string, PersistedReservation>();
  private readonly tombstonesById = new Map<string, SnapshotTombstone>();
  private readonly tombstonesByLogicalKey = new Map<string, SnapshotTombstone>();
  private readonly buildsByLogicalKey = new Map<string, BuildEntry>();
  private metadataTail: Promise<void> = Promise.resolve();
  private ownerMetadataBytes = 0;
  private closed = false;
  private fatalUnavailable = false;
  private recoveredQuotaExceeded = false;
  private recoveryIncomplete = false;

  private constructor(options: RelayV2StateSnapshotSpoolOptions) {
    assertOpaqueId(options.hostId, "hostId");
    this.hostId = options.hostId;
    this.ownerInstanceId = options.ownerInstanceId ?? randomUUID();
    assertOpaqueId(this.ownerInstanceId, "ownerInstanceId");
    const home = resolve(options.home ?? homedir());
    if (options.root === undefined) {
      this.paths = relayV2StateSnapshotSpoolPaths(home);
      this.trustedBoundary = home;
    } else {
      const physical = physicalCustomRoot(options.root);
      this.paths = pathsFromRoot(physical.root);
      this.trustedBoundary = physical.trustedBoundary;
    }
    this.verifyTrustedAncestors = true;
    this.takeoverExistingOwner = options.takeoverExistingOwner ?? false;
    this.cutSource = options.cutSource;
    this.now = options.now ?? Date.now;
    this.testHooks = options.testHooks;
    this.processIncarnationProbe = options.testHooks?.processIncarnationForPid
      ?? ((pid) => processIncarnationForPid(
        pid,
        options.testHooks?.bootSessionIdentity ?? productionBootSessionIdentity,
      ));
    const incarnation = this.processIncarnationProbe(process.pid);
    if (incarnation === null || incarnation === undefined) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot spool cannot establish its process incarnation",
      );
    }
    assertOpaqueId(incarnation, "processIncarnation");
    this.processIncarnation = incarnation;
    this.limits = Object.freeze({
      ...RELAY_V2_STATE_SNAPSHOT_LIMITS,
      ...options.testLimits,
    });
    this.validateLimits();
  }

  static async open(
    options: RelayV2StateSnapshotSpoolOptions,
  ): Promise<RelayV2StateSnapshotSpool> {
    try {
      const spool = new RelayV2StateSnapshotSpool(options);
      ensureSpoolDirectories(
        spool.paths,
        spool.trustedBoundary,
        spool.verifyTrustedAncestors,
      );
      await spool.serializeMetadata(
        async () => {
          spool.acquireOwnership();
          const hostEpoch = await spool.readCurrentHostEpoch();
          spool.recover(hostEpoch);
        },
        false,
      );
      return spool;
    } catch (error) {
      throw structuredSpoolError(error);
    }
  }

  async get(request: RelayV2StateSnapshotGet): Promise<RelayV2StateSnapshotChunk> {
    validateGet(request);
    const currentHostEpoch = await this.readCurrentHostEpoch();
    if (request.expectedHostEpoch !== currentHostEpoch) {
      await this.serializeMetadata(() => this.dropOtherLineages(currentHostEpoch));
      throw new RelayV2StateSnapshotSpoolError(
        "HOST_EPOCH_MISMATCH",
        "Relay v2 host lineage does not match",
        {
          expectedHostEpoch: request.expectedHostEpoch,
          actualHostEpoch: currentHostEpoch,
        },
      );
    }
    await this.serializeMetadata(() => {
      this.dropOtherLineages(currentHostEpoch);
      this.cleanupExpiredAt(this.readNow());
    });

    if (request.snapshotId !== null) {
      return this.serveExisting(request, request.snapshotId);
    }

    const binding = bindingFor(request);
    const key = logicalKey(binding);
    let decision = await this.serializeMetadata(() => this.existingFirst(key));
    if (decision === null) {
      const estimate = await this.readAdmissionEstimate(binding.hostEpoch);
      decision = await this.serializeMetadata(() => (
        this.beginFirst(binding, key, estimate)
      ));
    }
    if (decision.kind === "build") {
      void this.buildAndPublish(decision.reservation).then(
        () => decision.build.resolve(),
        (error) => decision.build.reject(error),
      );
    }
    if (decision.kind === "wait" || decision.kind === "build") {
      try {
        await decision.build.promise;
      } finally {
        await this.serializeMetadata(() => {
          if (this.buildsByLogicalKey.get(key) === decision.build) {
            this.buildsByLogicalKey.delete(key);
          }
        });
      }
    }
    const active = decision.kind === "active"
      ? decision.cut
      : await this.serializeMetadata(() => this.activeByLogicalKey.get(key));
    if (!active) throw expiredError();
    return this.serveExisting(request, active.manifest.snapshotId);
  }

  async release(
    request: RelayV2StateSnapshotRelease,
  ): Promise<RelayV2StateSnapshotReleased> {
    validateRelease(request);
    return this.serializeMetadata(() => this.withLineageFence(
      request.expectedHostEpoch,
      () => {
      const now = this.readNow();
      this.cleanupExpiredAt(now);
      const binding = bindingFor(request);
      const existingTombstone = this.tombstonesById.get(request.snapshotId);
      if (existingTombstone) {
        if (!sameBinding(existingTombstone.record.binding, binding)
          || existingTombstone.record.disposition !== "released") throw expiredError();
        this.removeCutIfPresent(request.snapshotId);
        return {
          hostEpoch: request.expectedHostEpoch,
          snapshotRequestId: request.snapshotRequestId,
          snapshotId: request.snapshotId,
          released: false,
          alreadyReleased: true,
          releasedAtMs: existingTombstone.record.recordedAtMs,
        };
      }
      if (this.recoveryIncomplete) {
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool recovery stopped at a frozen resource boundary",
        );
      }
      const active = this.activeById.get(request.snapshotId);
      if (!active || !sameBinding(active.manifest.binding, binding)) throw expiredError();
      const expiresAtMs = Math.min(
        now + this.limits.releaseTombstoneMs,
        active.manifest.snapshotAbsoluteExpiresAtMs,
      );
      if (expiresAtMs <= now) {
        this.expireActiveCut(active, now);
        throw expiredError();
      }
      let tombstone: PersistedSnapshotTombstone = {
        version: TOMBSTONE_VERSION,
        snapshotId: active.manifest.snapshotId,
        hostId: this.hostId,
        binding: clone(active.manifest.binding),
        disposition: "released",
        recordedAtMs: now,
        expiresAtMs,
        metadataBytes: 0,
      };
      tombstone = {
        ...tombstone,
        metadataBytes: metadataBytesForTombstone(tombstone),
      };
      if (tombstone.metadataBytes > RELEASE_TOMBSTONE_METADATA_HEADROOM_BYTES) {
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot release tombstone exceeded its reserved metadata headroom",
        );
      }
      this.installTombstone(tombstone);
      this.removeActiveCut(active);
      this.enforceRecoveredQuota();
      return {
        hostEpoch: request.expectedHostEpoch,
        snapshotRequestId: request.snapshotRequestId,
        snapshotId: request.snapshotId,
        released: true,
        alreadyReleased: false,
        releasedAtMs: now,
      };
      },
    ));
  }

  async cleanupExpired(): Promise<void> {
    const currentHostEpoch = await this.readCurrentHostEpoch();
    await this.serializeMetadata(() => {
      if (this.recoveryIncomplete) {
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool recovery stopped at a frozen resource boundary",
        );
      }
      this.dropOtherLineages(currentHostEpoch);
      this.cleanupExpiredAt(this.readNow());
      this.enforceRecoveredQuota();
    });
  }

  async close(): Promise<void> {
    await this.serializeMetadata(() => {
      try {
        for (const reservation of [...this.reservationsById.values()]) {
          this.expireReservation(reservation, expiredError());
        }
        rmSync(this.paths.owner, { force: true });
        fsyncDirectory(this.paths.root);
      } catch (error) {
        this.fatalUnavailable = true;
        throw error;
      }
      this.closed = true;
      this.activeById.clear();
      this.activeByLogicalKey.clear();
      this.reservationsById.clear();
      this.tombstonesById.clear();
      this.tombstonesByLogicalKey.clear();
      this.buildsByLogicalKey.clear();
    }, true, false);
  }

  private validateLimits(): void {
    for (const [name, value] of Object.entries(this.limits)) {
      const production = RELAY_V2_STATE_SNAPSHOT_LIMITS[
        name as keyof SnapshotLimits
      ];
      if (!Number.isSafeInteger(value) || value <= 0 || value > production) {
        throw new RelayV2StateSnapshotSpoolError(
          "INVALID_ARGUMENT",
          `invalid or widened Relay v2 snapshot limit ${name}`,
        );
      }
    }
    if (this.limits.maxChunkRecords > this.limits.maxCutRecords
      || this.limits.maxChunkCanonicalBytes > this.limits.maxCutCanonicalBytes
      || this.limits.maxCutCanonicalBytes > this.limits.maxSpoolCanonicalBytes) {
      throw new RelayV2StateSnapshotSpoolError(
        "INVALID_ARGUMENT",
        "Relay v2 snapshot limits are internally inconsistent",
      );
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RelayV2StateSnapshotSpoolError("INTERNAL", "snapshot clock is invalid");
    }
    return now;
  }

  private async readCurrentHostEpoch(): Promise<string> {
    try {
      const hostEpoch = await this.cutSource.currentHostEpoch();
      assertOpaqueId(hostEpoch, "hostEpoch");
      return hostEpoch;
    } catch (error) {
      throw mapSourceError(error);
    }
  }

  private async withLineageFence<T>(
    expectedHostEpoch: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await this.cutSource.withHostEpochFence(expectedHostEpoch, async () => {
        try {
          return await operation();
        } catch (error) {
          throw new LineageOperationError(error);
        }
      });
    } catch (error) {
      if (error instanceof LineageOperationError) throw error.cause;
      throw mapSourceError(error);
    }
  }

  private async readAdmissionEstimate(
    expectedHostEpoch: string,
  ): Promise<RelayV2MaterializedStateCutAdmissionEstimate> {
    let estimate: RelayV2MaterializedStateCutAdmissionEstimate;
    try {
      estimate = await this.cutSource.admissionEstimate(expectedHostEpoch);
    } catch (error) {
      throw mapSourceError(error);
    }
    if (estimate.hostEpoch !== expectedHostEpoch) {
      throw new RelayV2StateSnapshotSpoolError(
        "HOST_EPOCH_MISMATCH",
        "snapshot admission estimate crossed host lineage",
      );
    }
    if (!Number.isSafeInteger(estimate.totalRecords)
      || estimate.totalRecords < 0
      || !Number.isSafeInteger(estimate.totalCanonicalBytes)
      || estimate.totalCanonicalBytes < 2) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot admission estimate is invalid",
      );
    }
    if (estimate.totalRecords > this.limits.maxCutRecords
      || estimate.totalCanonicalBytes > this.limits.maxCutCanonicalBytes) {
      throw new RelayV2StateSnapshotSpoolError(
        "CAPABILITY_UNAVAILABLE",
        "snapshot admission estimate exceeds the cut boundary",
      );
    }
    return clone(estimate);
  }

  private async serializeMetadata<T>(
    operation: () => T | Promise<T>,
    requireOwner = true,
    verifyOwnerAfter = true,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.metadataTail;
    this.metadataTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.closed) throw ownerFencedError();
      return await this.withDiskMutex(async () => {
        if (requireOwner) this.assertCurrentOwner();
        const result = await operation();
        if (verifyOwnerAfter) this.assertCurrentOwner();
        return result;
      });
    } catch (error) {
      if (!isRelayV2StateSnapshotSpoolError(error)) {
        this.fatalUnavailable = true;
      }
      throw structuredSpoolError(error);
    } finally {
      release();
    }
  }

  private async withDiskMutex<T>(operation: () => T | Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const token = randomBytes(24).toString("base64url");
    const candidate = join(this.paths.lockCandidates, `candidate-${token}.json`);
    const candidateUsage = visitDirectoryBounded(
      this.paths.lockCandidates,
      MAX_LOCK_CANDIDATES,
      () => undefined,
    );
    if (candidateUsage.count >= MAX_LOCK_CANDIDATES) {
      throw new RelayV2StateSnapshotSpoolError(
        "BUSY",
        "snapshot spool coordination metadata is exhausted",
      );
    }
    try {
      const holder: PersistedLockHolder = {
        version: LOCK_VERSION,
        token,
        pid: process.pid,
        processIncarnation: this.processIncarnation,
      };
      writePrivateFile(candidate, jsonFile(holder));
      fsyncDirectory(this.paths.lockCandidates);
    } catch (error) {
      if (existsSync(candidate)) {
        assertPrivateFile(candidate, 4_096);
        rmSync(candidate);
      }
      fsyncDirectory(this.paths.lockCandidates);
      throw error;
    }
    let acquired = false;
    try {
      while (true) {
        try {
          linkSync(candidate, this.paths.lock);
          acquired = true;
          fsyncDirectory(this.paths.root);
          rmSync(candidate);
          fsyncDirectory(this.paths.lockCandidates);
          break;
        } catch (error) {
          if (!isRecord(error) || error.code !== "EEXIST") throw error;
          const observed = this.observeMetadataLock();
          const incompleteStillPublishing = observed.holder === undefined
            && Date.now() - observed.mtimeMs < LOCK_WAIT_TIMEOUT_MS;
          const holderIsCurrentIncarnation = observed.holder === undefined
            ? false
            : this.processIncarnationMatches(observed.holder);
          if (!incompleteStillPublishing
            && (observed.holder === undefined || holderIsCurrentIncarnation === false)) {
            await this.testHooks?.beforeStaleLockQuarantine?.(observed.identity);
            this.quarantineObservedLock(observed);
            continue;
          }
          if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
            throw new RelayV2StateSnapshotSpoolError(
              "BUSY",
              "snapshot spool metadata owner is busy",
            );
          }
          await delay(LOCK_RETRY_MS);
        }
      }
      await this.testHooks?.afterMetadataLockAcquired?.(token);
      const result = await operation();
      this.assertMetadataLock(token);
      return result;
    } finally {
      if (acquired) {
        await this.testHooks?.beforeMetadataLockRelease?.(token);
        this.releaseMetadataLock(token);
      }
      if (existsSync(candidate)) {
        assertPrivateFile(candidate, 4_096);
        rmSync(candidate);
        fsyncDirectory(this.paths.lockCandidates);
      }
    }
  }

  private observeMetadataLock(): {
    identity: string;
    device: number;
    inode: number;
    mtimeMs: number;
    holder: PersistedLockHolder | undefined;
  } {
    assertWithinBoundary(this.paths.lock, this.paths.root);
    assertPrivateFile(this.paths.lock, 4_096);
    const metadata = lstatSync(this.paths.lock);
    let holder: PersistedLockHolder | undefined;
    try {
      holder = readCanonicalPrivateFile(
        this.paths.lock,
        4_096,
        parseLockHolder,
      ).record;
    } catch (error) {
      if (error instanceof UnsafeSpoolPathError) throw error;
    }
    return {
      identity: holder === undefined
        ? `inode-${metadata.dev}-${metadata.ino}`
        : `token-${holder.token}`,
      device: metadata.dev,
      inode: metadata.ino,
      mtimeMs: metadata.mtimeMs,
      holder,
    };
  }

  private quarantineObservedLock(observed: {
    identity: string;
    device: number;
    inode: number;
  }): void {
    const quarantineUsage = visitDirectoryBounded(
      this.paths.lockQuarantine,
      MAX_LOCK_QUARANTINES,
      () => undefined,
    );
    const quarantine = join(
      this.paths.lockQuarantine,
      `stale-${observed.identity}.json`,
    );
    assertWithinBoundary(quarantine, this.paths.root);
    if (quarantineUsage.count >= MAX_LOCK_QUARANTINES && !existsSync(quarantine)) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot spool stale-lock quarantine is exhausted",
      );
    }
    if (existsSync(quarantine)) {
      assertPrivateFile(quarantine, 4_096);
      const quarantined = lstatSync(quarantine);
      if (quarantined.dev !== observed.device || quarantined.ino !== observed.inode) {
        this.fatalUnavailable = true;
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool stale lock quarantine identity conflicts",
        );
      }
      this.unlinkObservedMetadataLock(observed);
      return;
    }
    try {
      linkSync(this.paths.lock, quarantine);
    } catch (error) {
      if (isRecord(error)
        && (error.code === "ENOENT"
          || error.code === "EEXIST")) return;
      throw error;
    }
    const quarantined = lstatSync(quarantine);
    assertPrivateFile(quarantine, 4_096);
    fsyncDirectory(this.paths.lockQuarantine);
    if (quarantined.dev !== observed.device || quarantined.ino !== observed.inode) {
      return;
    }
    this.testHooks?.afterStaleLockQuarantinePersisted?.(observed.identity);
    this.unlinkObservedMetadataLock(observed);
  }

  private unlinkObservedMetadataLock(observed: {
    device: number;
    inode: number;
  }): void {
    let current: ReturnType<typeof lstatSync>;
    try {
      current = lstatSync(this.paths.lock);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (current.dev !== observed.device || current.ino !== observed.inode) return;
    try {
      rmSync(this.paths.lock);
      fsyncDirectory(this.paths.root);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }

  private assertMetadataLock(token: string): void {
    const observed = this.observeMetadataLock();
    if (observed.holder?.token !== token
      || observed.holder.pid !== process.pid
      || observed.holder.processIncarnation !== this.processIncarnation) {
      this.fatalUnavailable = true;
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot spool metadata lock was lost",
      );
    }
  }

  private releaseMetadataLock(token: string): void {
    this.assertMetadataLock(token);
    rmSync(this.paths.lock);
    fsyncDirectory(this.paths.root);
  }

  private acquireOwnership(): void {
    let previous: PersistedSpoolOwner | undefined;
    if (existsSync(this.paths.owner)) {
      previous = readCanonicalPrivateFile(
        this.paths.owner,
        this.limits.maxMetadataBytes,
        parseOwner,
      ).record;
      if (previous.hostId !== this.hostId) {
        throw new Error("snapshot spool owner host does not match");
      }
      const previousIsCurrentIncarnation = this.processIncarnationMatches(previous);
      if (previousIsCurrentIncarnation !== false && !this.takeoverExistingOwner) {
        throw new RelayV2StateSnapshotSpoolError(
          "BUSY",
          "snapshot spool already has a live owner",
        );
      }
    }
    const owner: PersistedSpoolOwner = {
      version: OWNER_VERSION,
      hostId: this.hostId,
      ownerInstanceId: this.ownerInstanceId,
      fence: this.ownerFence,
      acquiredAtMs: this.readNow(),
      pid: process.pid,
      processIncarnation: this.processIncarnation,
    };
    this.persistAtomic(this.paths.owner, jsonFile(owner));
    this.ownerMetadataBytes = jsonFile(owner).byteLength
      + COORDINATION_METADATA_ALLOWANCE_BYTES;
  }

  private assertCurrentOwner(): void {
    const owner = readCanonicalPrivateFile(
      this.paths.owner,
      this.limits.maxMetadataBytes,
      parseOwner,
    ).record;
    if (owner.hostId !== this.hostId
      || owner.ownerInstanceId !== this.ownerInstanceId
      || owner.fence !== this.ownerFence
      || owner.pid !== process.pid
      || owner.processIncarnation !== this.processIncarnation) {
      throw ownerFencedError();
    }
    this.ownerMetadataBytes = jsonFile(owner).byteLength
      + COORDINATION_METADATA_ALLOWANCE_BYTES;
    if (this.fatalUnavailable) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot spool is fail-closed after an uncertain persistence result",
      );
    }
  }

  private processIncarnationMatches(
    holder: Pick<PersistedSpoolOwner, "pid" | "processIncarnation">,
  ): boolean | undefined {
    const observed = this.processIncarnationProbe(holder.pid);
    if (observed === undefined) return undefined;
    return observed !== null && observed === holder.processIncarnation;
  }

  private persistAtomic(path: string, contents: Buffer): void {
    try {
      atomicWritePrivateFile(path, contents);
    } catch (error) {
      this.fatalUnavailable = true;
      throw error;
    }
  }

  private readRecoveryMetadata<T>(
    path: string,
    maxFileBytes: number,
    kind: "binding" | "lease" | "manifest" | "reservation" | "tombstone",
    budget: RecoveryMetadataBudget,
    parser: (value: unknown) => T,
  ): { record: T; actualBytes: number } {
    assertPrivateFile(path, maxFileBytes);
    const actualBytes = lstatSync(path).size;
    if (budget.actualBytes + actualBytes > this.limits.maxMetadataBytes) {
      throw new RecoveryMetadataQuotaError();
    }
    budget.actualBytes += actualBytes;
    this.testHooks?.beforeRecoveryMetadataRead?.(kind);
    const recovered = readCanonicalPrivateFile(path, maxFileBytes, parser);
    if (recovered.actualBytes !== actualBytes) {
      throw new UnsafeSpoolPathError("snapshot metadata changed while being recovered");
    }
    return recovered;
  }

  private recover(hostEpoch: string): void {
    assertOwnedDirectory(this.paths.root, true);
    assertOwnedDirectory(this.paths.cuts, true);
    assertOwnedDirectory(this.paths.staging, true);
    assertOwnedDirectory(this.paths.reservations, true);
    assertOwnedDirectory(this.paths.tombstones, true);
    assertOwnedDirectory(this.paths.lockCandidates, true);
    assertOwnedDirectory(this.paths.lockQuarantine, true);
    this.activeById.clear();
    this.activeByLogicalKey.clear();
    this.reservationsById.clear();
    this.tombstonesById.clear();
    this.tombstonesByLogicalKey.clear();
    this.recoveredQuotaExceeded = false;
    this.recoveryIncomplete = false;

    const recoveryMetadataBudget: RecoveryMetadataBudget = {
      actualBytes: lstatSync(this.paths.owner).size,
    };
    if (recoveryMetadataBudget.actualBytes > this.limits.maxMetadataBytes) {
      throw new RecoveryMetadataQuotaError();
    }

    assertPrivateFile(this.paths.lock, 4_096);
    visitDirectoryBounded(
      this.paths.lockCandidates,
      MAX_LOCK_CANDIDATES,
      (entry) => assertPrivateFile(join(this.paths.lockCandidates, entry), 4_096),
    );
    visitDirectoryBounded(
      this.paths.lockQuarantine,
      MAX_LOCK_QUARANTINES,
      (entry) => assertPrivateFile(join(this.paths.lockQuarantine, entry), 4_096),
    );

    const expectedRootEntries = new Set([
      basename(this.paths.cuts),
      basename(this.paths.staging),
      basename(this.paths.reservations),
      basename(this.paths.tombstones),
      OWNER_FILE,
      LOCK_FILE,
      LOCK_CANDIDATES_DIRECTORY,
      LOCK_QUARANTINE_DIRECTORY,
    ]);
    visitDirectoryBounded(this.paths.root, MAX_ROOT_ENTRIES, (entry) => {
      if (expectedRootEntries.has(entry)) return;
      const path = join(this.paths.root, entry);
      assertWithinBoundary(path, this.paths.root);
      if (!isAtomicTemporaryName(entry)) {
        throw new Error("snapshot spool root contains unknown persisted state");
      }
      assertPrivateFile(path, this.limits.maxMetadataBytes);
      rmSync(path, { force: true });
    });

    const now = this.readNow();
    let recoveredMetadataBytes = this.ownerMetadataBytes;
    visitDirectoryBounded(this.paths.tombstones, this.limits.maxTombstones, (entry) => {
      const path = join(this.paths.tombstones, entry);
      assertWithinBoundary(path, this.paths.root);
      if (isAtomicTemporaryName(entry)) {
        assertPrivateFile(path, this.limits.maxMetadataBytes);
        rmSync(path, { force: true });
        return;
      }
      const recovered = this.readRecoveryMetadata(
        path,
        this.limits.maxMetadataBytes,
        "tombstone",
        recoveryMetadataBudget,
        parseTombstone,
      );
      const record = recovered.record;
      if (entry !== `${record.snapshotId}.json`
        || record.hostId !== this.hostId
        || record.metadataBytes !== recovered.actualBytes) {
        throw new Error("snapshot tombstone identity or accounting is invalid");
      }
      if (record.binding.hostEpoch !== hostEpoch
        || (record.disposition === "released" && record.expiresAtMs <= now)) {
        rmSync(path, { force: true });
        return;
      }
      recoveredMetadataBytes += record.metadataBytes;
      const metadataExceeded = recoveredMetadataBytes > this.limits.maxMetadataBytes;
      const tombstone = { path, record };
      const key = logicalKey(record.binding);
      if (this.tombstonesById.has(record.snapshotId)
        || this.tombstonesByLogicalKey.has(key)) {
        throw new Error("snapshot tombstone binding is duplicated");
      }
      this.tombstonesById.set(record.snapshotId, tombstone);
      this.tombstonesByLogicalKey.set(key, tombstone);
      if (metadataExceeded) {
        this.recoveredQuotaExceeded = true;
        this.recoveryIncomplete = true;
        return false;
      }
    });

    visitDirectoryBounded(
      this.paths.reservations,
      this.limits.maxCutsPerHost * 2 + 2,
      (entry) => {
      if (this.recoveryIncomplete) return false;
      const path = join(this.paths.reservations, entry);
      assertWithinBoundary(path, this.paths.root);
      if (isAtomicTemporaryName(entry)) {
        assertPrivateFile(path, this.limits.maxMetadataBytes);
        rmSync(path, { force: true });
        return;
      }
      const reservation = this.readRecoveryMetadata(
        path,
        this.limits.maxMetadataBytes,
        "reservation",
        recoveryMetadataBudget,
        parseReservation,
      ).record;
      if (entry !== `${reservation.reservationId}.json`
        || reservation.hostId !== this.hostId) {
        throw new Error("snapshot reservation identity is invalid");
      }
      if (reservation.binding.hostEpoch !== hostEpoch) {
        rmSync(path, { force: true });
        return;
      }
      if (this.reservationsById.has(reservation.reservationId)) {
        throw new Error("snapshot reservation identity is duplicated");
      }
      if (this.wouldAddTombstoneObligation(reservation.binding)
        && this.tombstoneObligationCount() >= this.limits.maxTombstones) {
        this.recoveredQuotaExceeded = true;
        this.recoveryIncomplete = true;
        return false;
      }
      this.reservationsById.set(reservation.reservationId, reservation);
    });

    const stagingDirectories: Array<{ directory: string; snapshotId: string }> = [];
    visitDirectoryBounded(
      this.paths.staging,
      this.limits.maxCutsPerHost * 2 + 2,
      (entry) => {
      if (this.recoveryIncomplete) return false;
      const match = /^(snap_[A-Za-z0-9_-]+)\.[0-9a-f]{8}-[0-9a-f-]{27}\.tmp$/.exec(entry);
      if (!match) throw new Error("snapshot staging directory name is invalid");
      const snapshotId = match[1]!;
      assertOpaqueId(snapshotId, "snapshotId");
      const directory = join(this.paths.staging, entry);
      assertPrivateFlatDirectory(
        directory,
        this.paths.root,
        this.limits.maxCutRecords + 4,
        this.limits.maxMetadataBytes,
      );
      stagingDirectories.push({ directory, snapshotId });
    });

    const principalCounts = new Map<string, number>();
    let recoveredCanonicalBytes = 0;
    let recoveredActiveMetadataBytes = 0;
    visitDirectoryBounded(
      this.paths.cuts,
      this.limits.maxCutsPerHost * 2 + 2,
      (entry) => {
      if (this.recoveryIncomplete) return false;
      const directory = join(this.paths.cuts, entry);
      assertWithinBoundary(directory, this.paths.root);
      assertOwnedDirectory(directory, true);
      assertPrivateFlatDirectory(
        directory,
        this.paths.root,
        this.limits.maxCutRecords + 4,
        this.limits.maxMetadataBytes,
      );
      let removedTemporary = false;
      visitDirectoryBounded(
        directory,
        this.limits.maxCutRecords + 4,
        (filename) => {
          if (!isAtomicTemporaryName(filename)) return;
          const temporary = join(directory, filename);
          assertWithinBoundary(temporary, this.paths.root);
          assertPrivateFile(temporary, this.limits.maxMetadataBytes);
          rmSync(temporary, { force: true });
          removedTemporary = true;
        },
      );
      if (removedTemporary) fsyncDirectory(directory);
      const recovered = this.readRecoverableIdentity(directory, recoveryMetadataBudget);
      const identity = recovered.identity;
      if (identity.snapshotId !== entry || identity.hostId !== this.hostId) {
        throw new Error("snapshot cut directory identity is invalid");
      }
      if (identity.binding.hostEpoch !== hostEpoch) {
        rmSync(directory, { recursive: true, force: true });
        return;
      }
      if (!recovered.binding || !recovered.manifest) {
        if (!this.tombstonesById.has(identity.snapshotId)) {
          this.recordExpiredBinding(identity, now, true);
        }
        rmSync(directory, { recursive: true, force: true });
        fsyncDirectory(this.paths.cuts);
        return;
      }
      const existingTombstone = this.tombstonesById.get(identity.snapshotId);
      if (existingTombstone) {
        if (!sameBinding(existingTombstone.record.binding, identity.binding)) {
          throw new Error("snapshot cut conflicts with its persisted logical fence");
        }
        rmSync(directory, { recursive: true, force: true });
        fsyncDirectory(this.paths.cuts);
        return;
      }
      const manifest = recovered.manifest;
      const principal = identity.binding.principalId;
      const nextPrincipalCount = (principalCounts.get(principal) ?? 0) + 1;
      const quotaWouldBeExceeded = this.recoveredQuotaExceeded
        || this.activeById.size + 1 > this.limits.maxCutsPerHost
        || nextPrincipalCount > this.limits.maxCutsPerPrincipal
        || (this.wouldAddTombstoneObligation(identity.binding)
          && this.tombstoneObligationCount() >= this.limits.maxTombstones)
        || recoveredCanonicalBytes + manifest.totalCanonicalBytes
          > this.limits.maxSpoolCanonicalBytes
        || recoveredMetadataBytes + recoveredActiveMetadataBytes
          + manifest.metadataBytes
          > this.limits.maxMetadataBytes;
      if (quotaWouldBeExceeded) {
        this.recoveredQuotaExceeded = true;
        this.recoveryIncomplete = true;
        return false;
      }
      let cut: ActiveCut;
      try {
        cut = this.loadCut(
          directory,
          manifest,
          recovered.binding,
          recoveryMetadataBudget,
        );
        if (cut.lease.snapshotLeaseExpiresAtMs <= now
          || cut.manifest.snapshotAbsoluteExpiresAtMs <= now) {
          throw new Error("snapshot cut lease expired");
        }
      } catch (error) {
        if (error instanceof UnsafeSpoolPathError
          || error instanceof RecoveryMetadataQuotaError) throw error;
        this.recordExpiredBinding(identity, now, true);
        rmSync(directory, { recursive: true, force: true });
        fsyncDirectory(this.paths.cuts);
        return;
      }
      const key = logicalKey(cut.manifest.binding);
      if (this.activeByLogicalKey.has(key) || this.activeById.has(cut.manifest.snapshotId)) {
        throw new Error("snapshot cut binding is duplicated");
      }
      this.activeById.set(cut.manifest.snapshotId, cut);
      this.activeByLogicalKey.set(key, cut);
      principalCounts.set(principal, nextPrincipalCount);
      recoveredCanonicalBytes += cut.manifest.totalCanonicalBytes;
      recoveredActiveMetadataBytes += cut.manifest.metadataBytes;
    });

    if (!this.recoveryIncomplete) {
      for (const reservation of [...this.reservationsById.values()]) {
        const active = this.activeById.get(reservation.snapshotId);
        if (active && sameBinding(active.manifest.binding, reservation.binding)
          && active.manifest.snapshotCreatedAtMs === reservation.snapshotCreatedAtMs
          && active.manifest.snapshotAbsoluteExpiresAtMs
            === reservation.snapshotAbsoluteExpiresAtMs) {
          this.removeReservationFile(reservation);
        } else {
          this.expireReservation(reservation, expiredError(), true);
        }
      }
      for (const staging of stagingDirectories) {
        if (!this.activeById.has(staging.snapshotId)
          && !this.tombstonesById.has(staging.snapshotId)) {
          const recovered = this.readRecoverableIdentity(
            staging.directory,
            recoveryMetadataBudget,
          );
          this.recordExpiredBinding(recovered.identity, now, true);
        }
        if (!this.activeById.has(staging.snapshotId)
          && !this.tombstonesById.has(staging.snapshotId)) {
          throw new Error("snapshot staging state lacks durable logical evidence");
        }
        rmSync(staging.directory, { recursive: true, force: true });
        fsyncDirectory(this.paths.staging);
      }
    }
    this.enforceRecoveredQuota();
    fsyncDirectory(this.paths.staging);
    fsyncDirectory(this.paths.reservations);
    fsyncDirectory(this.paths.tombstones);
    fsyncDirectory(this.paths.cuts);
    fsyncDirectory(this.paths.root);
  }

  private readRecoverableIdentity(
    directory: string,
    recoveryMetadataBudget: RecoveryMetadataBudget,
  ): {
    identity: PersistedBindingMarker;
    binding: PersistedBindingMarker | undefined;
    manifest: PersistedManifest | undefined;
  } {
    assertWithinBoundary(directory, this.paths.root);
    assertOwnedDirectory(directory, true);
    let binding: PersistedBindingMarker | undefined;
    let manifest: PersistedManifest | undefined;
    let bindingFailure: unknown;
    let manifestFailure: unknown;
    try {
      binding = this.readBindingMarker(directory, recoveryMetadataBudget);
    } catch (error) {
      if (error instanceof RecoveryMetadataQuotaError) throw error;
      bindingFailure = error;
    }
    try {
      manifest = this.readManifest(directory, recoveryMetadataBudget);
    } catch (error) {
      if (error instanceof RecoveryMetadataQuotaError) throw error;
      manifestFailure = error;
    }
    if (bindingFailure instanceof UnsafeSpoolPathError
      || manifestFailure instanceof UnsafeSpoolPathError) {
      throw new UnsafeSpoolPathError("snapshot cut trust check failed");
    }
    if (!binding && !manifest) {
      throw new Error("snapshot cut lost both persisted identity copies");
    }
    const manifestBinding = manifest === undefined
      ? undefined
      : bindingMarkerFor(manifest);
    if (binding && manifestBinding
      && canonicalizeSnapshotJson(binding) !== canonicalizeSnapshotJson(manifestBinding)) {
      throw new Error("snapshot cut identity copies conflict");
    }
    return {
      identity: binding ?? manifestBinding!,
      binding,
      manifest,
    };
  }

  private readManifest(
    directory: string,
    recoveryMetadataBudget: RecoveryMetadataBudget,
  ): PersistedManifest {
    assertOwnedDirectory(directory, true);
    return this.readRecoveryMetadata(
      join(directory, MANIFEST_FILE),
      this.limits.maxMetadataBytes,
      "manifest",
      recoveryMetadataBudget,
      parseManifest,
    ).record;
  }

  private readBindingMarker(
    directory: string,
    recoveryMetadataBudget: RecoveryMetadataBudget,
  ): PersistedBindingMarker {
    assertOwnedDirectory(directory, true);
    return this.readRecoveryMetadata(
      join(directory, BINDING_FILE),
      this.limits.maxMetadataBytes,
      "binding",
      recoveryMetadataBudget,
      parseBindingMarker,
    ).record;
  }

  private loadCut(
    directory: string,
    recoveredManifest: PersistedManifest,
    recoveredBinding: PersistedBindingMarker,
    recoveryMetadataBudget: RecoveryMetadataBudget,
  ): ActiveCut {
    const manifest = recoveredManifest;
    const bindingMarker = recoveredBinding;
    if (canonicalizeSnapshotJson(bindingMarker)
      !== canonicalizeSnapshotJson(bindingMarkerFor(manifest))) {
      throw new Error("snapshot binding marker does not match its manifest");
    }
    const lease = this.readRecoveryMetadata(
      join(directory, LEASE_FILE),
      LEASE_METADATA_ALLOWANCE_BYTES,
      "lease",
      recoveryMetadataBudget,
      (value) => parseLease(value, manifest),
    ).record;
    if (manifest.totalRecords > this.limits.maxCutRecords
      || manifest.totalCanonicalBytes > this.limits.maxCutCanonicalBytes
      || manifest.metadataBytes > this.limits.maxMetadataBytes
      || manifest.metadataBytes !== metadataBytesForManifest(manifest)) {
      throw new Error("snapshot manifest exceeds quota or has invalid accounting");
    }
    const expectedFiles = new Set([
      BINDING_FILE,
      MANIFEST_FILE,
      LEASE_FILE,
      ...manifest.chunks.map((chunk) => chunk.file),
    ]);
    let actualFiles = 0;
    visitDirectoryBounded(directory, expectedFiles.size + 1, (entry) => {
      actualFiles += 1;
      if (!expectedFiles.has(entry)) {
        throw new Error("snapshot cut contains unexpected files");
      }
    });
    if (actualFiles !== expectedFiles.size) {
      throw new Error("snapshot cut contains unexpected files");
    }

    const fullDigest = createHash("sha256");
    fullDigest.update("[");
    let totalRecords = 0;
    let totalCanonicalBytes = 2;
    let firstRecord = true;
    const recordOrder = newRecordOrderState();
    const cursors = new Set<string>();
    for (const chunk of manifest.chunks) {
      if (chunk.recordCount > this.limits.maxChunkRecords
        || chunk.canonicalBytes > this.limits.maxChunkCanonicalBytes) {
        throw new Error("snapshot chunk exceeds its frozen boundary");
      }
      if (chunk.nextCursor !== null) {
        if (cursors.has(chunk.nextCursor)) throw new Error("snapshot cursor is duplicated");
        cursors.add(chunk.nextCursor);
      }
      const declaredRecordsThroughChunk = totalRecords + chunk.recordCount;
      const declaredBytesThroughChunk = totalCanonicalBytes
        + chunk.canonicalBytes - 2
        + (totalRecords > 0 && chunk.recordCount > 0 ? 1 : 0);
      if (declaredRecordsThroughChunk > manifest.totalRecords
        || declaredRecordsThroughChunk > this.limits.maxCutRecords
        || declaredBytesThroughChunk > manifest.totalCanonicalBytes
        || declaredBytesThroughChunk > this.limits.maxCutCanonicalBytes) {
        throw new Error("snapshot chunk totals exceed the manifest boundary");
      }
      this.testHooks?.beforeRecoveryChunkRead?.(chunk.index);
      const contents = readPrivateFile(
        join(directory, chunk.file),
        this.limits.maxChunkCanonicalBytes,
      );
      if (contents.byteLength !== chunk.canonicalBytes
        || createHash("sha256").update(contents).digest("base64url") !== chunk.digest) {
        throw new Error("snapshot chunk digest does not match");
      }
      const records = JSON.parse(contents.toString("utf8")) as unknown;
      if (!Array.isArray(records) || records.length !== chunk.recordCount
        || canonicalizeSnapshotJson(records) !== contents.toString("utf8")) {
        throw new Error("snapshot chunk canonical bytes do not match");
      }
      for (const record of records as RelayV2MaterializedStateCutRecord[]) {
        acceptRecordOrder(recordOrder, record);
        const canonical = canonicalizeSnapshotJson(record);
        if (!firstRecord) {
          fullDigest.update(",");
          totalCanonicalBytes += 1;
        }
        fullDigest.update(canonical, "utf8");
        totalCanonicalBytes += Buffer.byteLength(canonical, "utf8");
        totalRecords += 1;
        if (totalRecords > manifest.totalRecords
          || totalRecords > this.limits.maxCutRecords
          || totalCanonicalBytes > manifest.totalCanonicalBytes
          || totalCanonicalBytes > this.limits.maxCutCanonicalBytes) {
          throw new Error("snapshot records exceed the manifest boundary");
        }
        firstRecord = false;
      }
      if (totalRecords !== declaredRecordsThroughChunk
        || totalCanonicalBytes !== declaredBytesThroughChunk) {
        throw new Error("snapshot chunk totals do not match its manifest index");
      }
    }
    fullDigest.update("]");
    finishRecordOrder(recordOrder);
    if (totalRecords !== manifest.totalRecords
      || totalCanonicalBytes !== manifest.totalCanonicalBytes
      || fullDigest.digest("base64url") !== manifest.cutDigest) {
      throw new Error("snapshot cut digest or totals do not match");
    }
    return { directory, manifest, lease };
  }

  private enforceRecoveredQuota(): void {
    const principalCounts = new Map<string, number>();
    for (const cut of this.activeById.values()) {
      const principal = cut.manifest.binding.principalId;
      principalCounts.set(principal, (principalCounts.get(principal) ?? 0) + 1);
    }
    const activeMetadata = [...this.activeById.values()].reduce((sum, cut) => (
      sum + cut.manifest.metadataBytes
    ), 0);
    const tombstoneMetadata = [...this.tombstonesById.values()].reduce((sum, tombstone) => (
      sum + tombstone.record.metadataBytes
    ), 0);
    const invalidActiveQuota = this.activeById.size > this.limits.maxCutsPerHost
      || [...principalCounts.values()].some((count) => count > this.limits.maxCutsPerPrincipal)
      || this.tombstonesById.size > this.limits.maxTombstones
      || this.tombstoneObligationCount() > this.limits.maxTombstones
      || [...this.activeById.values()].reduce((sum, cut) => (
        sum + cut.manifest.totalCanonicalBytes
      ), 0) > this.limits.maxSpoolCanonicalBytes;
    this.recoveredQuotaExceeded = this.recoveredQuotaExceeded
      || this.recoveryIncomplete
      || invalidActiveQuota
      || this.ownerMetadataBytes + activeMetadata + tombstoneMetadata
        > this.limits.maxMetadataBytes;
  }

  private existingFirst(key: string): FirstDecision | null {
    const active = this.activeByLogicalKey.get(key);
    if (active) return { kind: "active", cut: active };
    const build = this.buildsByLogicalKey.get(key);
    if (build) return { kind: "wait", build };
    if (this.tombstonesByLogicalKey.has(key)) throw expiredError();
    return null;
  }

  private beginFirst(
    binding: SnapshotBinding,
    key: string,
    estimate: RelayV2MaterializedStateCutAdmissionEstimate,
  ): FirstDecision {
    const existing = this.existingFirst(key);
    if (existing) return existing;
    if (this.recoveredQuotaExceeded || this.recoveryIncomplete) {
      throw new RelayV2StateSnapshotSpoolError(
        "BUSY",
        "snapshot spool recovered above its frozen quota",
      );
    }
    if (estimate.hostEpoch !== binding.hostEpoch) {
      throw new RelayV2StateSnapshotSpoolError(
        "HOST_EPOCH_MISMATCH",
        "snapshot admission estimate crossed host lineage",
      );
    }

    const usage = this.usage();
    const principalCuts = [...this.activeById.values()].filter((cut) => (
      cut.manifest.binding.principalId === binding.principalId
    )).length + [...this.reservationsById.values()].filter((reservation) => (
      reservation.binding.principalId === binding.principalId
    )).length;
    const reservedMetadataBytes = Math.min(
      CONSERVATIVE_METADATA_RESERVATION_BYTES,
      this.limits.maxMetadataBytes,
    );
    if (principalCuts >= this.limits.maxCutsPerPrincipal
      || this.activeById.size + this.reservationsById.size >= this.limits.maxCutsPerHost
      || (this.wouldAddTombstoneObligation(binding)
        && this.tombstoneObligationCount() >= this.limits.maxTombstones)
      || usage.canonicalBytes + estimate.totalCanonicalBytes
        > this.limits.maxSpoolCanonicalBytes
      || usage.metadataBytes + reservedMetadataBytes > this.limits.maxMetadataBytes) {
      throw new RelayV2StateSnapshotSpoolError(
        "BUSY",
        "snapshot spool quota is exhausted",
      );
    }

    const now = this.readNow();
    const reservation: PersistedReservation = {
      version: RESERVATION_VERSION,
      reservationId: newReservationId(),
      snapshotId: newSnapshotId(),
      hostId: this.hostId,
      ownerFence: this.ownerFence,
      binding: clone(binding),
      snapshotCreatedAtMs: now,
      snapshotAbsoluteExpiresAtMs: now + this.limits.absoluteLeaseMs,
      reservedRecords: estimate.totalRecords,
      reservedCanonicalBytes: estimate.totalCanonicalBytes,
      reservedMetadataBytes,
    };
    if (!Number.isSafeInteger(reservation.snapshotAbsoluteExpiresAtMs)) {
      throw new RelayV2StateSnapshotSpoolError("INTERNAL", "snapshot lifetime overflowed");
    }
    const path = join(this.paths.reservations, `${reservation.reservationId}.json`);
    this.persistAtomic(path, jsonFile(reservation));
    this.reservationsById.set(reservation.reservationId, reservation);
    this.testHooks?.afterReservationPersisted?.(reservation.snapshotId);

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => undefined);
    const entry = { promise, resolve, reject };
    this.buildsByLogicalKey.set(key, entry);
    return { kind: "build", reservation, build: entry };
  }

  private usage(): { canonicalBytes: number; metadataBytes: number } {
    return {
      canonicalBytes: [...this.activeById.values()].reduce((sum, cut) => (
        sum + cut.manifest.totalCanonicalBytes
      ), 0) + [...this.reservationsById.values()].reduce((sum, reservation) => (
        sum + reservation.reservedCanonicalBytes
      ), 0),
      metadataBytes: [...this.activeById.values()].reduce((sum, cut) => (
        sum + cut.manifest.metadataBytes
      ), this.ownerMetadataBytes) + [...this.reservationsById.values()].reduce((sum, reservation) => (
        sum + reservation.reservedMetadataBytes
      ), 0) + [...this.tombstonesById.values()].reduce((sum, tombstone) => (
        sum + tombstone.record.metadataBytes
      ), 0),
    };
  }

  private tombstoneObligationCount(): number {
    const keys = new Set(this.tombstonesByLogicalKey.keys());
    for (const cut of this.activeById.values()) {
      keys.add(logicalKey(cut.manifest.binding));
    }
    for (const reservation of this.reservationsById.values()) {
      keys.add(logicalKey(reservation.binding));
    }
    return keys.size;
  }

  private wouldAddTombstoneObligation(binding: SnapshotBinding): boolean {
    const key = logicalKey(binding);
    return !this.tombstonesByLogicalKey.has(key)
      && !this.activeByLogicalKey.has(key)
      && ![...this.reservationsById.values()].some((reservation) => (
        logicalKey(reservation.binding) === key
      ));
  }

  private async buildAndPublish(reservation: PersistedReservation): Promise<void> {
    let cut: RelayV2MaterializedStateCut;
    try {
      cut = await this.cutSource.capture(reservation.binding.hostEpoch);
    } catch (error) {
      const sourceError = mapSourceError(error);
      await this.serializeMetadata(() => this.expireReservation(reservation, sourceError));
      throw sourceError;
    }
    try {
      if (cut.hostEpoch !== reservation.binding.hostEpoch) {
        throw new RelayV2StateSnapshotSpoolError(
          "HOST_EPOCH_MISMATCH",
          "materialized cut crossed host lineage",
        );
      }
      assertCanonicalCounter(cut.throughEventSeq, "throughEventSeq");
      assertCanonicalCounter(cut.scopesRevision, "scopesRevision");
      validateRecordStream(cut.records);
    } catch (error) {
      const failure = structuredSpoolError(error);
      await this.serializeMetadata(() => this.expireReservation(reservation, failure));
      throw failure;
    }

    await this.serializeMetadata(async () => {
      let stagingDirectory: string | undefined;
      let finalDirectory: string | undefined;
      let publication: "precommit" | "renamed" | "published" = "precommit";
      const publicationState = (): "precommit" | "renamed" | "published" => publication;
      let reservationRemoved = false;
      const removePublishedReservation = () => {
        if (reservationRemoved) return;
        this.removeReservationFile(reservation);
        reservationRemoved = true;
      };
      const expireBuildingReservation = (
        failure: RelayV2StateSnapshotSpoolError,
      ) => {
        if (reservationRemoved) return;
        this.expireReservation(reservation, failure);
        reservationRemoved = true;
      };
      try {
        const activeReservation = this.reservationsById.get(reservation.reservationId);
        if (!activeReservation
          || activeReservation.ownerFence !== this.ownerFence
          || logicalKey(activeReservation.binding) !== logicalKey(reservation.binding)) {
          throw expiredError();
        }
        if (this.readNow() >= reservation.snapshotAbsoluteExpiresAtMs) {
          throw expiredError();
        }
        stagingDirectory = join(
          this.paths.staging,
          `${reservation.snapshotId}.${randomUUID()}.tmp`,
        );
        mkdirSync(stagingDirectory, { mode: 0o700 });
        assertOwnedDirectory(stagingDirectory, true);
        const built = this.writeCut(stagingDirectory, reservation, cut);
        const withoutReservation = this.usage();
        withoutReservation.canonicalBytes -= reservation.reservedCanonicalBytes;
        withoutReservation.metadataBytes -= reservation.reservedMetadataBytes;
        if (built.manifest.totalRecords > reservation.reservedRecords
          || built.manifest.totalCanonicalBytes > reservation.reservedCanonicalBytes
          || built.manifest.metadataBytes > reservation.reservedMetadataBytes
          || withoutReservation.canonicalBytes + built.manifest.totalCanonicalBytes
            > this.limits.maxSpoolCanonicalBytes
          || withoutReservation.metadataBytes + built.manifest.metadataBytes
            > this.limits.maxMetadataBytes) {
          throw new RelayV2StateSnapshotSpoolError(
            "BUSY",
            "snapshot spool quota cannot publish the completed cut",
          );
        }
        await this.withLineageFence(reservation.binding.hostEpoch, () => {
          const stillReserved = this.reservationsById.get(reservation.reservationId);
          if (!stillReserved || stillReserved.ownerFence !== this.ownerFence
            || this.readNow() >= reservation.snapshotAbsoluteExpiresAtMs) {
            throw expiredError();
          }
          finalDirectory = join(this.paths.cuts, reservation.snapshotId);
          renameSync(stagingDirectory!, finalDirectory);
          publication = "renamed";
          this.syncDirectory(this.paths.cuts, "publish_cuts");
          this.syncDirectory(this.paths.staging, "publish_staging");
          publication = "published";
          stagingDirectory = undefined;
          const cutRecord: ActiveCut = {
            directory: finalDirectory,
            manifest: built.manifest,
            lease: built.lease,
          };
          this.activeById.set(reservation.snapshotId, cutRecord);
          this.activeByLogicalKey.set(logicalKey(reservation.binding), cutRecord);
          removePublishedReservation();
        });
      } catch (error) {
        const failure = structuredSpoolError(error);
        try {
          if (publicationState() !== "published") {
            expireBuildingReservation(failure);
          }
          if (publicationState() === "renamed" && finalDirectory !== undefined) {
            rmSync(finalDirectory, { recursive: true, force: true });
            this.syncDirectory(this.paths.cuts, "rollback_cuts");
            this.syncDirectory(this.paths.staging, "rollback_staging");
            stagingDirectory = undefined;
          } else if (publicationState() === "precommit" && stagingDirectory !== undefined) {
            rmSync(stagingDirectory, { recursive: true, force: true });
            fsyncDirectory(this.paths.staging);
            stagingDirectory = undefined;
          }
        } catch {
          this.fatalUnavailable = true;
          throw new RelayV2StateSnapshotSpoolError(
            "INTERNAL",
            "snapshot publication rollback is uncertain and the spool is fail-closed",
          );
        }
        if (publicationState() === "published") {
          this.fatalUnavailable = true;
          throw new RelayV2StateSnapshotSpoolError(
            "INTERNAL",
            "snapshot publication committed with uncertain metadata cleanup",
          );
        }
        throw failure;
      }
    });
  }

  private syncDirectory(
    path: string,
    point: "publish_cuts" | "publish_staging" | "rollback_cuts" | "rollback_staging",
  ): void {
    this.testHooks?.beforeDirectoryFsync?.(point);
    fsyncDirectory(path);
  }

  private writeCut(
    directory: string,
    reservation: PersistedReservation,
    cut: RelayV2MaterializedStateCut,
  ): { manifest: PersistedManifest; lease: PersistedLease } {
    const fullDigest = createHash("sha256");
    fullDigest.update("[");
    let firstRecord = true;
    let totalRecords = 0;
    let totalCanonicalBytes = 2;
    let currentRecords: Buffer[] = [];
    let currentCanonicalBytes = 2;
    const chunks: PersistedChunkIndex[] = [];

    const flush = () => {
      const contents = Buffer.concat([
        Buffer.from("["),
        ...currentRecords.flatMap((record, index) => (
          index === 0 ? [record] : [Buffer.from(","), record]
        )),
        Buffer.from("]"),
      ]);
      const index = chunks.length;
      const file = chunkFilename(index);
      writePrivateFile(join(directory, file), contents);
      this.testHooks?.afterChunkWrite?.(index);
      chunks.push({
        index,
        file,
        recordCount: currentRecords.length,
        canonicalBytes: contents.byteLength,
        digest: createHash("sha256").update(contents).digest("base64url"),
        nextCursor: null,
      });
      currentRecords = [];
      currentCanonicalBytes = 2;
    };

    for (const record of cut.records) {
      const canonical = Buffer.from(
        canonicalizeSnapshotJson(record),
        "utf8",
      );
      const nextTotalRecords = totalRecords + 1;
      const nextTotalCanonicalBytes = totalCanonicalBytes
        + canonical.byteLength
        + (firstRecord ? 0 : 1);
      if (nextTotalRecords > reservation.reservedRecords
        || nextTotalCanonicalBytes > reservation.reservedCanonicalBytes) {
        throw new RelayV2StateSnapshotSpoolError(
          "BUSY",
          "materialized cut exceeded its admission reservation",
        );
      }
      const addition = canonical.byteLength + (currentRecords.length === 0 ? 0 : 1);
      if (currentRecords.length > 0
        && (currentRecords.length >= this.limits.maxChunkRecords
          || currentCanonicalBytes + addition > this.limits.maxChunkCanonicalBytes)) {
        flush();
      }
      if (canonical.byteLength + 2 > this.limits.maxChunkCanonicalBytes) {
        throw new RelayV2StateSnapshotSpoolError(
          "CAPABILITY_UNAVAILABLE",
          "one materialized record exceeds the snapshot chunk boundary",
        );
      }
      currentRecords.push(canonical);
      currentCanonicalBytes += canonical.byteLength
        + (currentRecords.length === 1 ? 0 : 1);
      if (!firstRecord) {
        fullDigest.update(",");
      }
      fullDigest.update(canonical);
      totalCanonicalBytes = nextTotalCanonicalBytes;
      totalRecords = nextTotalRecords;
      firstRecord = false;
      if (totalRecords > this.limits.maxCutRecords
        || totalCanonicalBytes > this.limits.maxCutCanonicalBytes) {
        throw new RelayV2StateSnapshotSpoolError(
          "CAPABILITY_UNAVAILABLE",
          "materialized cut exceeds the snapshot boundary",
        );
      }
    }
    if (currentRecords.length > 0 || chunks.length === 0) flush();
    fullDigest.update("]");
    for (let index = 0; index < chunks.length - 1; index += 1) {
      chunks[index]!.nextCursor = newCursor();
    }
    const initialLeaseExpiresAtMs = Math.min(
      this.readNow() + this.limits.idleLeaseMs,
      reservation.snapshotAbsoluteExpiresAtMs,
    );
    const lease: PersistedLease = {
      version: LEASE_VERSION,
      snapshotId: reservation.snapshotId,
      snapshotLeaseExpiresAtMs: initialLeaseExpiresAtMs,
    };
    let manifest: PersistedManifest = {
      version: SPOOL_VERSION,
      snapshotId: reservation.snapshotId,
      hostId: this.hostId,
      binding: clone(reservation.binding),
      snapshotCreatedAtMs: reservation.snapshotCreatedAtMs,
      snapshotAbsoluteExpiresAtMs: reservation.snapshotAbsoluteExpiresAtMs,
      throughEventSeq: cut.throughEventSeq,
      scopesRevision: cut.scopesRevision,
      totalRecords,
      totalCanonicalBytes,
      cutDigest: fullDigest.digest("base64url"),
      metadataBytes: 0,
      chunks,
    };
    manifest = { ...manifest, metadataBytes: metadataBytesForManifest(manifest) };
    writePrivateFile(
      join(directory, BINDING_FILE),
      jsonFile(bindingMarkerFor(manifest)),
    );
    writePrivateFile(join(directory, MANIFEST_FILE), jsonFile(manifest));
    writePrivateFile(join(directory, LEASE_FILE), jsonFile(lease));
    fsyncDirectory(directory);
    return { manifest, lease };
  }

  private async serveExisting(
    request: RelayV2StateSnapshotGet,
    snapshotId: string,
  ): Promise<RelayV2StateSnapshotChunk> {
    return this.serializeMetadata(async () => {
      if (this.recoveredQuotaExceeded || this.recoveryIncomplete) {
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool recovered above its frozen quota",
        );
      }
      const now = this.readNow();
      this.cleanupExpiredAt(now);
      const cut = this.activeById.get(snapshotId);
      const binding = bindingFor(request);
      if (!cut || !sameBinding(cut.manifest.binding, binding)) throw expiredError();
      const chunk = cut.manifest.chunks[request.nextChunkIndex];
      if (!chunk) {
        throw new RelayV2StateSnapshotSpoolError(
          "INVALID_ARGUMENT",
          "snapshot chunk index is not available",
        );
      }
      const expectedCursor = request.nextChunkIndex === 0
        ? null
        : cut.manifest.chunks[request.nextChunkIndex - 1]!.nextCursor;
      if (request.cursor !== expectedCursor) {
        throw new RelayV2StateSnapshotSpoolError(
          "INVALID_ARGUMENT",
          "snapshot cursor does not match the requested chunk index",
        );
      }
      const nextLease = Math.max(
        cut.lease.snapshotLeaseExpiresAtMs,
        Math.min(
          now + this.limits.idleLeaseMs,
          cut.manifest.snapshotAbsoluteExpiresAtMs,
        ),
      );
      if (nextLease !== cut.lease.snapshotLeaseExpiresAtMs) {
        cut.lease = {
          ...cut.lease,
          snapshotLeaseExpiresAtMs: nextLease,
        };
        this.persistAtomic(join(cut.directory, LEASE_FILE), jsonFile(cut.lease));
      }
      let contents: Buffer;
      try {
        contents = readPrivateFile(
          join(cut.directory, chunk.file),
          this.limits.maxChunkCanonicalBytes,
        );
        if (contents.byteLength !== chunk.canonicalBytes
          || createHash("sha256").update(contents).digest("base64url") !== chunk.digest) {
          throw new Error("snapshot chunk digest does not match");
        }
      } catch (error) {
        if (error instanceof UnsafeSpoolPathError) {
          this.fatalUnavailable = true;
          throw error;
        }
        this.expireActiveCut(cut, now);
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool failed its immutable chunk check",
        );
      }
      const records = JSON.parse(contents.toString("utf8")) as RelayV2MaterializedStateCutRecord[];
      const response: RelayV2StateSnapshotChunk = {
        hostEpoch: cut.manifest.binding.hostEpoch,
        coverageComplete: true,
        snapshotRequestId: cut.manifest.binding.snapshotRequestId,
        snapshotId: cut.manifest.snapshotId,
        snapshotCreatedAtMs: cut.manifest.snapshotCreatedAtMs,
        snapshotLeaseExpiresAtMs: cut.lease.snapshotLeaseExpiresAtMs,
        snapshotAbsoluteExpiresAtMs: cut.manifest.snapshotAbsoluteExpiresAtMs,
        chunkIndex: chunk.index,
        isLast: chunk.index === cut.manifest.chunks.length - 1,
        nextCursor: chunk.nextCursor,
        throughEventSeq: cut.manifest.throughEventSeq,
        scopesRevision: cut.manifest.scopesRevision,
        totalRecords: cut.manifest.totalRecords,
        totalCanonicalBytes: cut.manifest.totalCanonicalBytes,
        cutDigest: cut.manifest.cutDigest,
        records: clone(records),
      };
      return this.withLineageFence(request.expectedHostEpoch, () => response);
    });
  }

  private cleanupExpiredAt(now: number): void {
    for (const cut of [...this.activeById.values()]) {
      if (cut.lease.snapshotLeaseExpiresAtMs <= now
        || cut.manifest.snapshotAbsoluteExpiresAtMs <= now) {
        this.expireActiveCut(cut, now);
      }
    }
    for (const [snapshotId, tombstone] of this.tombstonesById) {
      if (tombstone.record.disposition !== "released"
        || tombstone.record.expiresAtMs > now) continue;
      this.removeTombstoneFile(tombstone.path);
      this.tombstonesById.delete(snapshotId);
      const key = logicalKey(tombstone.record.binding);
      if (this.tombstonesByLogicalKey.get(key)?.record.snapshotId === snapshotId) {
        this.tombstonesByLogicalKey.delete(key);
      }
    }
    for (const reservation of [...this.reservationsById.values()]) {
      if (reservation.snapshotAbsoluteExpiresAtMs <= now) {
        this.expireReservation(reservation, expiredError());
      }
    }
  }

  private dropOtherLineages(hostEpoch: string): void {
    for (const cut of [...this.activeById.values()]) {
      if (cut.manifest.binding.hostEpoch !== hostEpoch) this.removeActiveCut(cut);
    }
    for (const [snapshotId, tombstone] of this.tombstonesById) {
      if (tombstone.record.binding.hostEpoch === hostEpoch) continue;
      this.removeTombstoneFile(tombstone.path);
      this.tombstonesById.delete(snapshotId);
      const key = logicalKey(tombstone.record.binding);
      if (this.tombstonesByLogicalKey.get(key)?.record.snapshotId === snapshotId) {
        this.tombstonesByLogicalKey.delete(key);
      }
    }
    for (const reservation of [...this.reservationsById.values()]) {
      if (reservation.binding.hostEpoch !== hostEpoch) {
        this.removeReservationFile(reservation);
      }
    }
  }

  private recordExpiredBinding(
    marker: PersistedBindingMarker,
    now: number,
    recovery = false,
  ): void {
    const key = logicalKey(marker.binding);
    const byId = this.tombstonesById.get(marker.snapshotId);
    const byLogicalKey = this.tombstonesByLogicalKey.get(key);
    if (byId || byLogicalKey) {
      if (!byId || !byLogicalKey || byId !== byLogicalKey
        || !sameBinding(byId.record.binding, marker.binding)) {
        throw new Error("snapshot logical expiry fence conflicts with persisted evidence");
      }
      return;
    }
    let tombstone: PersistedSnapshotTombstone = {
      version: TOMBSTONE_VERSION,
      snapshotId: marker.snapshotId,
      hostId: this.hostId,
      binding: clone(marker.binding),
      disposition: "expired",
      recordedAtMs: now,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
      metadataBytes: 0,
    };
    tombstone = {
      ...tombstone,
      metadataBytes: metadataBytesForTombstone(tombstone),
    };
    if (tombstone.metadataBytes > RELEASE_TOMBSTONE_METADATA_HEADROOM_BYTES) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot tombstone exceeded its reserved metadata headroom",
      );
    }
    this.installTombstone(tombstone);
    if (recovery) {
      this.testHooks?.afterRecoveryExpiredFencePersisted?.(marker.snapshotId);
    }
  }

  private installTombstone(record: PersistedSnapshotTombstone): void {
    const key = logicalKey(record.binding);
    const byId = this.tombstonesById.get(record.snapshotId);
    const byKey = this.tombstonesByLogicalKey.get(key);
    if ((byId && !sameBinding(byId.record.binding, record.binding))
      || (byKey && byKey.record.snapshotId !== record.snapshotId)) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot tombstone conflicts with persisted logical evidence",
      );
    }
    if (!byId && this.tombstonesById.size >= this.limits.maxTombstones) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot tombstone capacity is exhausted",
      );
    }
    if (this.wouldAddTombstoneObligation(record.binding)
      && this.tombstoneObligationCount() >= this.limits.maxTombstones) {
      throw new RelayV2StateSnapshotSpoolError(
        "INTERNAL",
        "snapshot logical fence capacity is exhausted",
      );
    }
    const path = join(this.paths.tombstones, `${record.snapshotId}.json`);
    this.persistAtomic(path, jsonFile(record));
    this.testHooks?.afterTombstonePersisted?.(
      record.snapshotId,
      record.disposition,
    );
    const tombstone = { path, record };
    this.tombstonesById.set(record.snapshotId, tombstone);
    this.tombstonesByLogicalKey.set(key, tombstone);
  }

  private removeTombstoneFile(path: string): void {
    try {
      rmSync(path, { force: true });
      fsyncDirectory(this.paths.tombstones);
    } catch (error) {
      this.fatalUnavailable = true;
      throw error;
    }
  }

  private expireActiveCut(cut: ActiveCut, now: number): void {
    this.recordExpiredBinding(bindingMarkerFor(cut.manifest), now);
    this.removeActiveCut(cut);
  }

  private removeActiveCut(cut: ActiveCut): void {
    try {
      rmSync(cut.directory, { recursive: true, force: true });
      fsyncDirectory(this.paths.cuts);
    } catch (error) {
      this.fatalUnavailable = true;
      throw error;
    }
    this.activeById.delete(cut.manifest.snapshotId);
    const key = logicalKey(cut.manifest.binding);
    if (this.activeByLogicalKey.get(key) === cut) this.activeByLogicalKey.delete(key);
  }

  private removeCutIfPresent(snapshotId: string): void {
    const cut = this.activeById.get(snapshotId);
    if (cut) this.removeActiveCut(cut);
  }

  private expireReservation(
    reservation: PersistedReservation,
    failure: RelayV2StateSnapshotSpoolError,
    recovery = false,
  ): void {
    this.recordExpiredBinding(
      bindingMarkerForReservation(reservation),
      this.readNow(),
      recovery,
    );
    const key = logicalKey(reservation.binding);
    const build = this.buildsByLogicalKey.get(key);
    if (build) {
      build.reject(failure);
      this.buildsByLogicalKey.delete(key);
    }
    this.removeReservationFile(reservation);
  }

  private removeReservationFile(reservation: PersistedReservation): void {
    try {
      rmSync(join(this.paths.reservations, `${reservation.reservationId}.json`), { force: true });
      fsyncDirectory(this.paths.reservations);
    } catch (error) {
      this.fatalUnavailable = true;
      throw error;
    }
    this.reservationsById.delete(reservation.reservationId);
  }
}
