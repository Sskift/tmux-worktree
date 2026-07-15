import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const MANIFEST_FILE = "manifest-v1.json";
const BINDING_FILE = "binding-v1.json";
const LEASE_FILE = "lease-v1.json";
const LEASE_METADATA_ALLOWANCE_BYTES = 256;
const RELEASE_TOMBSTONE_METADATA_HEADROOM_BYTES = 16_384;
const CONSERVATIVE_METADATA_RESERVATION_BYTES = 1_048_576;

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
  releaseTombstoneMs: 600_000,
});

type SnapshotLimits = RelayV2StateSnapshotLimits;

export interface RelayV2StateSnapshotSpoolPaths {
  root: string;
  cuts: string;
  staging: string;
  reservations: string;
  tombstones: string;
}

export interface RelayV2StateSnapshotSpoolOptions {
  hostId: string;
  cutSource: RelayV2MaterializedStateCutSource;
  home?: string;
  root?: string;
  now?: () => number;
  /** Tests may only shrink production-frozen boundaries. */
  testLimits?: Partial<SnapshotLimits>;
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

export class RelayV2StateSnapshotSpoolError extends Error {
  constructor(
    readonly code: RelayV2StateSnapshotSpoolErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RelayV2StateSnapshotSpoolError";
  }
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

function assertPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)) {
    throw new RelayV2StateSnapshotSpoolError(
      "INTERNAL",
      "snapshot spool path is not a private owned directory",
    );
  }
  if ((metadata.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function ensureSpoolDirectories(paths: RelayV2StateSnapshotSpoolPaths): void {
  assertPrivateDirectory(paths.root);
  assertPrivateDirectory(paths.cuts);
  assertPrivateDirectory(paths.staging);
  assertPrivateDirectory(paths.reservations);
  assertPrivateDirectory(paths.tombstones);
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
  assertPrivateDirectory(directory);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writePrivateFile(temporary, contents);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readPrivateFile(path: string, maxBytes: number): Buffer {
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)
    || metadata.size > maxBytes) {
    throw new Error("snapshot spool file is invalid");
  }
  if ((metadata.mode & 0o077) !== 0) chmodSync(path, 0o600);
  return readFileSync(path);
}

function jsonFile(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
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

function validateRecordStream(records: readonly RelayV2MaterializedStateCutRecord[]): void {
  if (!Array.isArray(records)) throw new Error("materialized snapshot records are invalid");
  let currentScope: string | null = null;
  let lastScope: string | null = null;
  let lastSession: string | null = null;
  let sawSessionsScope = false;
  for (const record of records) {
    if (!isRecord(record) || typeof record.recordType !== "string") {
      throw new Error("materialized snapshot record is malformed");
    }
    if (record.recordType === "scope") {
      if (!exactKeys(record, ["recordType", "item"])
        || !isRecord(record.item)
        || typeof record.item.scopeId !== "string"
        || (currentScope !== null && !sawSessionsScope)
        || (lastScope !== null && utf8Compare(lastScope, record.item.scopeId) >= 0)) {
        throw new Error("materialized scope record order is invalid");
      }
      currentScope = record.item.scopeId;
      lastScope = currentScope;
      lastSession = null;
      sawSessionsScope = false;
    } else if (record.recordType === "sessions_scope") {
      if (!exactKeys(record, [
        "recordType", "scopeId", "revision", "completeness",
      ])
        || currentScope === null
        || sawSessionsScope
        || record.scopeId !== currentScope
        || record.completeness !== "complete") {
        throw new Error("materialized sessions_scope record order is invalid");
      }
      assertCanonicalCounter(record.revision, "sessions revision");
      sawSessionsScope = true;
    } else if (record.recordType === "session") {
      if (!exactKeys(record, ["recordType", "scopeId", "item"])
        || currentScope === null
        || !sawSessionsScope
        || record.scopeId !== currentScope
        || !isRecord(record.item)
        || record.item.scopeId !== currentScope
        || typeof record.item.sessionId !== "string"
        || (lastSession !== null && utf8Compare(lastSession, record.item.sessionId) >= 0)) {
        throw new Error("materialized Session record order is invalid");
      }
      lastSession = record.item.sessionId;
    } else {
      throw new Error("materialized snapshot record type is invalid");
    }
    canonicalizeSnapshotJson(record);
  }
  if (currentScope !== null && !sawSessionsScope) {
    throw new Error("materialized scope is missing its sessions_scope record");
  }
}

function expiredError(): RelayV2StateSnapshotSpoolError {
  return new RelayV2StateSnapshotSpoolError(
    "SNAPSHOT_EXPIRED",
    "snapshot is unavailable or expired",
  );
}

function mapSourceError(error: unknown): RelayV2StateSnapshotSpoolError {
  if (error instanceof RelayV2StateSnapshotSpoolError) return error;
  if (isRecord(error) && typeof error.code === "string") {
    const code = error.code;
    if (code === "BUSY"
      || code === "CAPABILITY_UNAVAILABLE"
      || code === "HOST_EPOCH_MISMATCH"
      || code === "INTERNAL"
      || code === "INVALID_ARGUMENT") {
      return new RelayV2StateSnapshotSpoolError(
        code,
        error instanceof Error ? error.message : "materialized snapshot source failed",
        isRecord(error.details) ? clone(error.details) : null,
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
  return clone(binding);
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
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
      throw new Error(`snapshot manifest ${field} is invalid`);
    }
  }
  assertDigest(value.cutDigest, "cut digest");
  if (value.snapshotAbsoluteExpiresAtMs <= value.snapshotCreatedAtMs
    || value.chunks.length === 0) {
    throw new Error("snapshot manifest lifetime or chunks are invalid");
  }
  const chunks = value.chunks.map((chunk, index) => {
    if (!isRecord(chunk) || !exactKeys(chunk, [
      "index", "file", "recordCount", "canonicalBytes", "digest", "nextCursor",
    ])
      || chunk.index !== index
      || chunk.file !== chunkFilename(index)
      || !Number.isSafeInteger(chunk.recordCount)
      || chunk.recordCount < 0
      || !Number.isSafeInteger(chunk.canonicalBytes)
      || chunk.canonicalBytes < 2) {
      throw new Error("snapshot chunk index is malformed");
    }
    assertDigest(chunk.digest, "chunk digest");
    if (index === value.chunks.length - 1) {
      if (chunk.nextCursor !== null) throw new Error("last snapshot chunk has a cursor");
    } else {
      assertOpaqueId(chunk.nextCursor, "nextCursor", 1_024);
    }
    return clone(chunk) as unknown as PersistedChunkIndex;
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
    totalRecords: value.totalRecords,
    totalCanonicalBytes: value.totalCanonicalBytes,
    cutDigest: value.cutDigest,
    metadataBytes: value.metadataBytes,
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
  return value as unknown as PersistedLease;
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
  if (!Number.isSafeInteger(value.metadataBytes) || value.metadataBytes <= 0
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
    "version", "reservationId", "snapshotId", "hostId", "binding",
    "snapshotCreatedAtMs", "snapshotAbsoluteExpiresAtMs", "reservedRecords",
    "reservedCanonicalBytes", "reservedMetadataBytes",
  ]) || value.version !== RESERVATION_VERSION) {
    throw new Error("snapshot reservation is malformed");
  }
  assertOpaqueId(value.reservationId, "reservationId");
  assertOpaqueId(value.snapshotId, "snapshotId");
  assertOpaqueId(value.hostId, "hostId");
  const binding = parseBinding(value.binding);
  assertSafeTimestamp(value.snapshotCreatedAtMs, "createdAt");
  assertSafeTimestamp(value.snapshotAbsoluteExpiresAtMs, "absolute expiry");
  if (!Number.isSafeInteger(value.reservedRecords)
    || value.reservedRecords < 0
    || !Number.isSafeInteger(value.reservedCanonicalBytes)
    || value.reservedCanonicalBytes <= 0
    || !Number.isSafeInteger(value.reservedMetadataBytes)
    || value.reservedMetadataBytes <= 0) {
    throw new Error("snapshot reservation quota is invalid");
  }
  return {
    version: RESERVATION_VERSION,
    reservationId: value.reservationId,
    snapshotId: value.snapshotId,
    hostId: value.hostId,
    binding,
    snapshotCreatedAtMs: value.snapshotCreatedAtMs,
    snapshotAbsoluteExpiresAtMs: value.snapshotAbsoluteExpiresAtMs,
    reservedRecords: value.reservedRecords,
    reservedCanonicalBytes: value.reservedCanonicalBytes,
    reservedMetadataBytes: value.reservedMetadataBytes,
  };
}

export class RelayV2StateSnapshotSpool {
  readonly hostId: string;
  readonly paths: RelayV2StateSnapshotSpoolPaths;
  readonly limits: Readonly<SnapshotLimits>;

  private readonly cutSource: RelayV2MaterializedStateCutSource;
  private readonly now: () => number;
  private readonly activeById = new Map<string, ActiveCut>();
  private readonly activeByLogicalKey = new Map<string, ActiveCut>();
  private readonly reservationsById = new Map<string, PersistedReservation>();
  private readonly tombstonesById = new Map<string, SnapshotTombstone>();
  private readonly tombstonesByLogicalKey = new Map<string, SnapshotTombstone>();
  private readonly buildsByLogicalKey = new Map<string, BuildEntry>();
  private metadataTail: Promise<void> = Promise.resolve();

  private constructor(options: RelayV2StateSnapshotSpoolOptions) {
    assertOpaqueId(options.hostId, "hostId");
    this.hostId = options.hostId;
    this.paths = options.root === undefined
      ? relayV2StateSnapshotSpoolPaths(options.home)
      : pathsFromRoot(options.root);
    this.cutSource = options.cutSource;
    this.now = options.now ?? Date.now;
    this.limits = Object.freeze({
      ...RELAY_V2_STATE_SNAPSHOT_LIMITS,
      ...options.testLimits,
    });
    this.validateLimits();
  }

  static async open(
    options: RelayV2StateSnapshotSpoolOptions,
  ): Promise<RelayV2StateSnapshotSpool> {
    const spool = new RelayV2StateSnapshotSpool(options);
    const hostEpoch = await spool.readCurrentHostEpoch();
    await spool.serializeMetadata(() => spool.recover(hostEpoch));
    return spool;
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
    if (decision.kind === "wait") {
      await decision.build.promise;
    } else if (decision.kind === "build") {
      try {
        await this.buildAndPublish(decision.reservation);
        decision.build.resolve();
      } catch (error) {
        decision.build.reject(error);
        throw error;
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
    return this.serializeMetadata(() => {
      const now = this.readNow();
      this.dropOtherLineages(currentHostEpoch);
      this.cleanupExpiredAt(now);
      const binding = bindingFor(request);
      const existingTombstone = this.tombstonesById.get(request.snapshotId);
      if (existingTombstone) {
        if (!sameBinding(existingTombstone.record.binding, binding)
          || existingTombstone.record.disposition !== "released") throw expiredError();
        this.removeCutIfPresent(request.snapshotId);
        return {
          hostEpoch: currentHostEpoch,
          snapshotRequestId: request.snapshotRequestId,
          snapshotId: request.snapshotId,
          released: false,
          alreadyReleased: true,
          releasedAtMs: existingTombstone.record.recordedAtMs,
        };
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
      return {
        hostEpoch: currentHostEpoch,
        snapshotRequestId: request.snapshotRequestId,
        snapshotId: request.snapshotId,
        released: true,
        alreadyReleased: false,
        releasedAtMs: now,
      };
    });
  }

  async cleanupExpired(): Promise<void> {
    const currentHostEpoch = await this.readCurrentHostEpoch();
    await this.serializeMetadata(() => {
      this.dropOtherLineages(currentHostEpoch);
      this.cleanupExpiredAt(this.readNow());
    });
  }

  private validateLimits(): void {
    for (const [name, value] of Object.entries(this.limits)) {
      const production = RELAY_V2_STATE_SNAPSHOT_LIMITS[
        name as keyof SnapshotLimits
      ];
      if (!Number.isSafeInteger(value) || value <= 0 || value > production) {
        throw new Error(`invalid or widened Relay v2 snapshot limit ${name}`);
      }
    }
    if (this.limits.maxChunkRecords > this.limits.maxCutRecords
      || this.limits.maxChunkCanonicalBytes > this.limits.maxCutCanonicalBytes
      || this.limits.maxCutCanonicalBytes > this.limits.maxSpoolCanonicalBytes) {
      throw new Error("Relay v2 snapshot limits are internally inconsistent");
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

  private async serializeMetadata<T>(operation: () => T): Promise<T> {
    let release!: () => void;
    const previous = this.metadataTail;
    this.metadataTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }

  private recover(hostEpoch: string): void {
    ensureSpoolDirectories(this.paths);
    this.activeById.clear();
    this.activeByLogicalKey.clear();
    this.reservationsById.clear();
    this.tombstonesById.clear();
    this.tombstonesByLogicalKey.clear();

    for (const entry of readdirSync(this.paths.staging)) {
      rmSync(join(this.paths.staging, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(this.paths.reservations)) {
      rmSync(join(this.paths.reservations, entry), { recursive: true, force: true });
    }

    const now = this.readNow();
    for (const entry of readdirSync(this.paths.tombstones)) {
      const path = join(this.paths.tombstones, entry);
      try {
        const record = parseTombstone(JSON.parse(
          readPrivateFile(path, this.limits.maxMetadataBytes).toString("utf8"),
        ));
        if (entry !== `${record.snapshotId}.json`
          || record.hostId !== this.hostId
          || record.binding.hostEpoch !== hostEpoch
          || record.expiresAtMs <= now
          || record.metadataBytes !== jsonFile(record).byteLength) {
          throw new Error("snapshot tombstone is invalid or expired");
        }
        const tombstone = { path, record };
        const key = logicalKey(record.binding);
        if (this.tombstonesById.has(record.snapshotId)
          || this.tombstonesByLogicalKey.has(key)) {
          throw new Error("snapshot tombstone binding is duplicated");
        }
        this.tombstonesById.set(record.snapshotId, tombstone);
        this.tombstonesByLogicalKey.set(key, tombstone);
      } catch {
        rmSync(path, { recursive: true, force: true });
      }
    }

    const duplicateLogicalKeys = new Set<string>();
    for (const entry of readdirSync(this.paths.cuts)) {
      const directory = join(this.paths.cuts, entry);
      let recoverableBinding: PersistedBindingMarker | undefined;
      let recoverableManifest: PersistedManifest | undefined;
      try {
        recoverableBinding = this.readBindingMarker(directory);
        recoverableManifest = this.readManifest(directory);
        const cut = this.loadCut(directory, recoverableManifest);
        if (entry !== cut.manifest.snapshotId
          || cut.manifest.hostId !== this.hostId
          || cut.manifest.binding.hostEpoch !== hostEpoch
          || cut.lease.snapshotLeaseExpiresAtMs <= now
          || cut.manifest.snapshotAbsoluteExpiresAtMs <= now
          || this.tombstonesById.has(cut.manifest.snapshotId)) {
          throw new Error("snapshot cut is unavailable for this lineage");
        }
        const key = logicalKey(cut.manifest.binding);
        const duplicate = this.activeByLogicalKey.get(key);
        if (duplicate || this.activeById.has(cut.manifest.snapshotId)) {
          duplicateLogicalKeys.add(key);
          if (duplicate) this.removeActiveCut(duplicate);
          throw new Error("snapshot cut binding is duplicated");
        }
        this.activeById.set(cut.manifest.snapshotId, cut);
        this.activeByLogicalKey.set(key, cut);
      } catch {
        rmSync(directory, { recursive: true, force: true });
        const binding = recoverableManifest === undefined
          ? recoverableBinding
          : bindingMarkerFor(recoverableManifest);
        if (binding?.snapshotId === entry
          && binding.hostId === this.hostId
          && binding.binding.hostEpoch === hostEpoch
          && !this.tombstonesById.has(binding.snapshotId)) {
          this.recordExpiredBinding(binding, now);
        }
      }
    }
    for (const key of duplicateLogicalKeys) {
      const cut = this.activeByLogicalKey.get(key);
      if (cut) this.removeActiveCut(cut);
    }
    this.enforceRecoveredQuota();
    fsyncDirectory(this.paths.staging);
    fsyncDirectory(this.paths.reservations);
    fsyncDirectory(this.paths.tombstones);
    fsyncDirectory(this.paths.cuts);
  }

  private readManifest(directory: string): PersistedManifest {
    assertPrivateDirectory(directory);
    return parseManifest(JSON.parse(
      readPrivateFile(
        join(directory, MANIFEST_FILE),
        this.limits.maxMetadataBytes,
      ).toString("utf8"),
    ));
  }

  private readBindingMarker(directory: string): PersistedBindingMarker {
    assertPrivateDirectory(directory);
    return parseBindingMarker(JSON.parse(
      readPrivateFile(
        join(directory, BINDING_FILE),
        this.limits.maxMetadataBytes,
      ).toString("utf8"),
    ));
  }

  private loadCut(
    directory: string,
    recoveredManifest?: PersistedManifest,
  ): ActiveCut {
    const manifest = recoveredManifest ?? this.readManifest(directory);
    const bindingMarker = this.readBindingMarker(directory);
    if (canonicalizeSnapshotJson(bindingMarker)
      !== canonicalizeSnapshotJson(bindingMarkerFor(manifest))) {
      throw new Error("snapshot binding marker does not match its manifest");
    }
    const lease = parseLease(JSON.parse(
      readPrivateFile(join(directory, LEASE_FILE), LEASE_METADATA_ALLOWANCE_BYTES)
        .toString("utf8"),
    ), manifest);
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
    if (readdirSync(directory).some((entry) => !expectedFiles.has(entry))
      || readdirSync(directory).length !== expectedFiles.size) {
      throw new Error("snapshot cut contains unexpected files");
    }

    const fullDigest = createHash("sha256");
    fullDigest.update("[");
    let totalRecords = 0;
    let totalCanonicalBytes = 2;
    let firstRecord = true;
    const allRecords: RelayV2MaterializedStateCutRecord[] = [];
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
        const canonical = canonicalizeSnapshotJson(record);
        if (!firstRecord) {
          fullDigest.update(",");
          totalCanonicalBytes += 1;
        }
        fullDigest.update(canonical, "utf8");
        totalCanonicalBytes += Buffer.byteLength(canonical, "utf8");
        totalRecords += 1;
        firstRecord = false;
        allRecords.push(record);
      }
    }
    fullDigest.update("]");
    validateRecordStream(allRecords);
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
      || [...this.activeById.values()].reduce((sum, cut) => (
        sum + cut.manifest.totalCanonicalBytes
      ), 0) > this.limits.maxSpoolCanonicalBytes;
    if (activeMetadata + tombstoneMetadata > this.limits.maxMetadataBytes) {
      for (const tombstone of this.tombstonesById.values()) {
        rmSync(tombstone.path, { force: true });
      }
      this.tombstonesById.clear();
      this.tombstonesByLogicalKey.clear();
    }
    if (invalidActiveQuota
      || [...this.activeById.values()].reduce((sum, cut) => (
        sum + cut.manifest.metadataBytes
      ), 0) > this.limits.maxMetadataBytes) {
      const now = this.readNow();
      for (const cut of [...this.activeById.values()]) this.expireActiveCut(cut, now);
    }
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
    atomicWritePrivateFile(path, jsonFile(reservation));
    this.reservationsById.set(reservation.reservationId, reservation);

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
      ), 0) + [...this.reservationsById.values()].reduce((sum, reservation) => (
        sum + reservation.reservedMetadataBytes
      ), 0) + [...this.tombstonesById.values()].reduce((sum, tombstone) => (
        sum + tombstone.record.metadataBytes
      ), 0),
    };
  }

  private async buildAndPublish(reservation: PersistedReservation): Promise<void> {
    let stagingDirectory: string | undefined;
    try {
      let cut: RelayV2MaterializedStateCut;
      try {
        cut = await this.cutSource.capture(reservation.binding.hostEpoch);
      } catch (error) {
        throw mapSourceError(error);
      }
      if (cut.hostEpoch !== reservation.binding.hostEpoch) {
        throw new RelayV2StateSnapshotSpoolError(
          "HOST_EPOCH_MISMATCH",
          "materialized cut crossed host lineage",
        );
      }
      assertCanonicalCounter(cut.throughEventSeq, "throughEventSeq");
      assertCanonicalCounter(cut.scopesRevision, "scopesRevision");
      validateRecordStream(cut.records);
      stagingDirectory = join(
        this.paths.staging,
        `${reservation.snapshotId}.${randomUUID()}.tmp`,
      );
      mkdirSync(stagingDirectory, { mode: 0o700 });
      const built = this.writeCut(stagingDirectory, reservation, cut);
      const currentHostEpoch = await this.readCurrentHostEpoch();
      if (currentHostEpoch !== reservation.binding.hostEpoch) {
        throw new RelayV2StateSnapshotSpoolError(
          "HOST_EPOCH_MISMATCH",
          "host lineage changed while the snapshot cut was being spooled",
          {
            expectedHostEpoch: reservation.binding.hostEpoch,
            actualHostEpoch: currentHostEpoch,
          },
        );
      }
      await this.serializeMetadata(() => {
        const activeReservation = this.reservationsById.get(reservation.reservationId);
        if (!activeReservation || logicalKey(activeReservation.binding)
          !== logicalKey(reservation.binding)) {
          throw expiredError();
        }
        const now = this.readNow();
        if (now >= reservation.snapshotAbsoluteExpiresAtMs) throw expiredError();
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
        const finalDirectory = join(this.paths.cuts, reservation.snapshotId);
        renameSync(stagingDirectory!, finalDirectory);
        fsyncDirectory(this.paths.cuts);
        fsyncDirectory(this.paths.staging);
        stagingDirectory = undefined;
        const cutRecord: ActiveCut = {
          directory: finalDirectory,
          manifest: built.manifest,
          lease: built.lease,
        };
        this.activeById.set(reservation.snapshotId, cutRecord);
        this.activeByLogicalKey.set(logicalKey(reservation.binding), cutRecord);
        this.removeReservation(reservation);
      });
    } catch (error) {
      await this.serializeMetadata(() => this.removeReservation(reservation));
      if (stagingDirectory !== undefined) {
        rmSync(stagingDirectory, { recursive: true, force: true });
        fsyncDirectory(this.paths.staging);
      }
      throw error instanceof RelayV2StateSnapshotSpoolError
        ? error
        : new RelayV2StateSnapshotSpoolError(
            "INTERNAL",
            "snapshot spool build failed before publication",
          );
    }
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
    return this.serializeMetadata(() => {
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
        atomicWritePrivateFile(join(cut.directory, LEASE_FILE), jsonFile(cut.lease));
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
      } catch {
        this.expireActiveCut(cut, now);
        throw new RelayV2StateSnapshotSpoolError(
          "INTERNAL",
          "snapshot spool failed its immutable chunk check",
        );
      }
      const records = JSON.parse(contents.toString("utf8")) as RelayV2MaterializedStateCutRecord[];
      return {
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
    });
  }

  private cleanupExpiredAt(now: number): void {
    for (const cut of [...this.activeById.values()]) {
      if (cut.lease.snapshotLeaseExpiresAtMs <= now
        || cut.manifest.snapshotAbsoluteExpiresAtMs <= now) {
        this.expireActiveCut(cut, now);
      }
    }
    let removedTombstone = false;
    for (const [snapshotId, tombstone] of this.tombstonesById) {
      if (tombstone.record.expiresAtMs > now) continue;
      rmSync(tombstone.path, { force: true });
      removedTombstone = true;
      this.tombstonesById.delete(snapshotId);
      const key = logicalKey(tombstone.record.binding);
      if (this.tombstonesByLogicalKey.get(key)?.record.snapshotId === snapshotId) {
        this.tombstonesByLogicalKey.delete(key);
      }
    }
    if (removedTombstone) fsyncDirectory(this.paths.tombstones);
    for (const reservation of [...this.reservationsById.values()]) {
      if (reservation.snapshotAbsoluteExpiresAtMs <= now) this.removeReservation(reservation);
    }
  }

  private dropOtherLineages(hostEpoch: string): void {
    for (const cut of [...this.activeById.values()]) {
      if (cut.manifest.binding.hostEpoch !== hostEpoch) this.removeActiveCut(cut);
    }
    for (const [snapshotId, tombstone] of this.tombstonesById) {
      if (tombstone.record.binding.hostEpoch === hostEpoch) continue;
      rmSync(tombstone.path, { force: true });
      this.tombstonesById.delete(snapshotId);
      const key = logicalKey(tombstone.record.binding);
      if (this.tombstonesByLogicalKey.get(key)?.record.snapshotId === snapshotId) {
        this.tombstonesByLogicalKey.delete(key);
      }
    }
    for (const reservation of [...this.reservationsById.values()]) {
      if (reservation.binding.hostEpoch !== hostEpoch) this.removeReservation(reservation);
    }
  }

  private recordExpiredBinding(
    marker: PersistedBindingMarker,
    now: number,
  ): void {
    const key = logicalKey(marker.binding);
    if (this.tombstonesById.has(marker.snapshotId)
      || this.tombstonesByLogicalKey.has(key)) return;
    const expiresAtMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      now + this.limits.releaseTombstoneMs,
    );
    let tombstone: PersistedSnapshotTombstone = {
      version: TOMBSTONE_VERSION,
      snapshotId: marker.snapshotId,
      hostId: this.hostId,
      binding: clone(marker.binding),
      disposition: "expired",
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
        "snapshot tombstone exceeded its reserved metadata headroom",
      );
    }
    this.installTombstone(tombstone);
  }

  private installTombstone(record: PersistedSnapshotTombstone): void {
    const path = join(this.paths.tombstones, `${record.snapshotId}.json`);
    atomicWritePrivateFile(path, jsonFile(record));
    const tombstone = { path, record };
    this.tombstonesById.set(record.snapshotId, tombstone);
    this.tombstonesByLogicalKey.set(logicalKey(record.binding), tombstone);
  }

  private expireActiveCut(cut: ActiveCut, now: number): void {
    this.recordExpiredBinding(bindingMarkerFor(cut.manifest), now);
    this.removeActiveCut(cut);
  }

  private removeActiveCut(cut: ActiveCut): void {
    rmSync(cut.directory, { recursive: true, force: true });
    this.activeById.delete(cut.manifest.snapshotId);
    const key = logicalKey(cut.manifest.binding);
    if (this.activeByLogicalKey.get(key) === cut) this.activeByLogicalKey.delete(key);
    fsyncDirectory(this.paths.cuts);
  }

  private removeCutIfPresent(snapshotId: string): void {
    const cut = this.activeById.get(snapshotId);
    if (cut) this.removeActiveCut(cut);
  }

  private removeReservation(reservation: PersistedReservation): void {
    rmSync(join(this.paths.reservations, `${reservation.reservationId}.json`), { force: true });
    this.reservationsById.delete(reservation.reservationId);
    fsyncDirectory(this.paths.reservations);
  }
}
