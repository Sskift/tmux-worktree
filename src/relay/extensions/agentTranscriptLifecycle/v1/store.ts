import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createRelayAgentAuthorityState,
  getRelayAgentAuthorityDedupeEvidence,
  reduceRelayAgentAuthority,
  restoreRelayAgentAuthorityState,
  snapshotRelayAgentAuthorityState,
  type RelayAgentAuthorityBinding,
  type RelayAgentAuthorityCapacityOverride,
  type RelayAgentAuthorityPublicEvent,
  type RelayAgentAuthorityReduction,
  type RelayAgentAuthoritySnapshotV1,
  type RelayAgentLifecycleRecord,
  type RelayAgentTextEntryRecord,
  type RelayAgentTrustedAdapterBinding,
} from "./authority.js";
import {
  RELAY_AGENT_DEFAULT_REPLAY_RETENTION_MS,
  RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
  RELAY_AGENT_MAX_PAGE_RECORDS,
  RELAY_AGENT_MIN_REPLAY_RETENTION_MS,
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
  encodeRelayAgentTranscriptLifecycleFrame,
  validateRelayAgentTranscriptLifecycleFrame,
} from "./codec.js";
import type { RelayV2JsonObject } from "../../../v2/codecSchema.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  RelayV2JsonError,
} from "../../../v2/strictJson.js";
import {
  RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
  RelayV2ContinuityAnchor,
  type RelayV2ContinuityAnchorErrorCode,
  type RelayV2ContinuityAnchorOptions,
  type RelayV2ContinuityCheckpoint,
  type RelayV2ContinuityLocalCasResult,
} from "../../../v2/continuityAnchor.js";

export const RELAY_AGENT_AUTHORITY_STORE_VERSION = 2 as const;
export const RELAY_AGENT_AUTHORITY_CONTINUITY_VERSION = 1 as const;
export const RELAY_AGENT_AUTHORITY_STORE_MAX_PERSISTED_BYTES = 268_435_456;

const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_STATE_JSON_KEYS = 1_000_000;
const MAX_STATE_JSON_NODES = 2_000_000;
const MAX_STATE_JSON_DEPTH = 32;
const MAX_STATE_JSON_DIRECT_KEYS = 256;
const MAX_SESSION_COUNT = 256;
const MAX_PUBLIC_EVENTS_PER_TIMELINE = 100_000;
const MAX_SNAPSHOTS_PER_STORE = 16;
const MAX_SNAPSHOTS_PER_PRINCIPAL = 2;
const MAX_REPLAY_CUTS_PER_STORE = 32;
const MAX_SNAPSHOT_TOMBSTONES_PER_STORE = 1_024;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const MAX_RECONCILE_REVALIDATION_ATTEMPTS = 16;
const MAX_CONTINUITY_BYTES = 16_384;
const WORST_CASE_WIRE_REQUEST_ID = "\u0001".repeat(128);
const WORST_CASE_WIRE_CURSOR = "\u0001".repeat(1_024);
const CONTINUITY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export type RelayAgentTimelineUnavailableReason =
  | "agent_unsupported"
  | "session_not_agent_managed"
  | "adapter_unavailable"
  | "store_unavailable";

export interface RelayAgentAuthorityStoreOwner {
  hostId: string;
  hostEpoch: string;
}

export interface RelayAgentAuthorityTarget {
  scopeId: string;
  sessionId: string;
}

export interface RelayAgentAuthorityStorePaths {
  state: string;
  continuity: string;
  lock: string;
}

export interface RelayAgentAuthorityStoreOptions extends RelayAgentAuthorityStoreOwner {
  /** Required rollback-independent authority; there is deliberately no default. */
  continuityAnchor: RelayV2ContinuityAnchorOptions;
  home?: string;
  paths?: RelayAgentAuthorityStorePaths;
  eventReplayRetentionMs?: number;
  authorityCapacityOverride?: RelayAgentAuthorityCapacityOverride;
  now?: () => number;
  randomId?: () => string;
  randomCursor?: () => string;
  renameFile?: (source: string, destination: string) => void;
  fsyncDirectory?: (path: string) => void;
  /** Tests may only shrink the exact serialized-file budget. */
  testMaxPersistedBytes?: number;
  /** Tests may only shrink the production strict-JSON budgets. */
  testMaxPersistedJsonKeys?: number;
  testMaxPersistedJsonNodes?: number;
}

export interface RelayAgentTimelineStatusAvailable {
  support: "available";
  reason: null;
  liveSource: "connected" | "interrupted";
  activeSourceEpoch: string;
  timelineEpoch: string;
  currentAgentSeq: string;
  earliestReplaySeq: string;
  limits: {
    maxTextUtf8Bytes: 65_536;
    maxPageRecords: 256;
    eventReplayRetentionMs: number;
    snapshotLeaseMs: 300_000;
  };
}

export interface RelayAgentTimelineStatusUnavailable {
  support: "unavailable";
  reason: RelayAgentTimelineUnavailableReason;
  liveSource: "absent";
  activeSourceEpoch: null;
  timelineEpoch: null;
  currentAgentSeq: null;
  earliestReplaySeq: null;
  limits: null;
}

export type RelayAgentTimelineStatus =
  | RelayAgentTimelineStatusAvailable
  | RelayAgentTimelineStatusUnavailable;

export interface RelayAgentSnapshotGet {
  principalId: string;
  clientInstanceId: string;
  target: RelayAgentAuthorityTarget;
  snapshotRequestId: string;
  snapshotId: string | null;
  cursor: string | null;
  nextPageIndex: number;
}

export interface RelayAgentSnapshotPage {
  timelineEpoch: string;
  snapshotRequestId: string;
  snapshotId: string;
  pageIndex: number;
  isLast: boolean;
  nextCursor: string | null;
  throughAgentSeq: string;
  earliestRetainedSeq: string;
  records: readonly (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[];
}

export interface RelayAgentReplayGet {
  principalId: string;
  clientInstanceId: string;
  target: RelayAgentAuthorityTarget;
  timelineEpoch: string;
  afterAgentSeq: string;
  cursor: string | null;
  limit: number;
}

export interface RelayAgentReplayEvent {
  agentEventSeq: string;
  eventId: string;
  occurredAtMs: number;
  mutation: RelayAgentAuthorityPublicEvent["mutation"];
}

export interface RelayAgentReplayPage {
  timelineEpoch: string;
  afterAgentSeq: string;
  replayThroughAgentSeq: string;
  isLast: boolean;
  nextCursor: string | null;
  events: readonly RelayAgentReplayEvent[];
}

export interface RelayAgentTimelineReset {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  previousTimelineEpoch: string;
  newTimelineEpoch: string;
  reason: "deleted";
}

interface PersistedSourceDedupeRetention {
  sourceEpoch: string;
  sourceEventId: string;
  committedAtMs: number;
}

interface PersistedPublicEvent {
  committedAtMs: number;
  event: RelayAgentAuthorityPublicEvent;
}

interface PersistedSnapshotCut {
  principalId: string;
  clientInstanceId: string;
  snapshotRequestId: string;
  snapshotId: string;
  createdAtMs: number;
  expiresAtMs: number;
  throughAgentSeq: string;
  earliestRetainedSeq: string;
  recordPages: (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[][];
  pageCursors: string[];
}

interface PersistedSnapshotTombstone {
  principalId: string;
  clientInstanceId: string;
  snapshotRequestId: string;
  snapshotId: string;
  expiresAtMs: number;
}

interface PersistedReplayCut {
  principalId: string;
  clientInstanceId: string;
  afterAgentSeq: string;
  limit: number;
  replayThroughAgentSeq: string;
  createdAtMs: number;
  expiresAtMs: number;
  eventPages: RelayAgentAuthorityPublicEvent[][];
  pageCursors: string[];
}

interface PersistedTimeline {
  timelineEpoch: string;
  authority: RelayAgentAuthoritySnapshotV1;
  dedupeRetention: PersistedSourceDedupeRetention[];
  events: PersistedPublicEvent[];
  snapshots: PersistedSnapshotCut[];
  snapshotTombstones: PersistedSnapshotTombstone[];
  replayCuts: PersistedReplayCut[];
}

interface PersistedSession {
  scopeId: string;
  sessionId: string;
  support: "available" | "unavailable";
  unavailableReason: Exclude<RelayAgentTimelineUnavailableReason, "store_unavailable"> | null;
  timeline: PersistedTimeline | null;
}

interface PersistedStoreUnsigned {
  version: typeof RELAY_AGENT_AUTHORITY_STORE_VERSION;
  owner: RelayAgentAuthorityStoreOwner;
  policy: {
    eventReplayRetentionMs: number;
    snapshotLeaseMs: typeof RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS;
  };
  commitSeq: string;
  commitId: string;
  parentCommitId: string | null;
  lastObservedAtMs: number;
  sessions: PersistedSession[];
}

interface PersistedStore extends PersistedStoreUnsigned {
  checksum: string;
}

interface ContinuityWitness {
  version: typeof RELAY_AGENT_AUTHORITY_CONTINUITY_VERSION;
  owner: RelayAgentAuthorityStoreOwner;
  commitSeq: string;
  commitId: string;
  stateChecksum: string;
}

interface StoreLock {
  path: string;
  owner: string;
}

interface StoreLockOwner {
  owner: string;
  pid: number;
  createdAtMs: number;
}

type FileInspection<T> =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: T; bytes: Buffer };

class AtomicPublishError extends Error {
  constructor(
    readonly path: string,
    readonly published: boolean,
    readonly original: unknown,
  ) {
    super("Relay Agent authority atomic publication failed");
    this.name = "AtomicPublishError";
  }
}

export class RelayAgentAuthorityStoreCorruptError extends Error {
  readonly code = "AGENT_AUTHORITY_STORE_CORRUPT" as const;
  constructor(message = "Relay Agent authority store continuity is corrupt") {
    super(message);
    this.name = "RelayAgentAuthorityStoreCorruptError";
  }
}

export class RelayAgentAuthorityStoreOwnershipError extends Error {
  readonly code = "AGENT_AUTHORITY_STORE_OWNERSHIP_UNKNOWN" as const;
  constructor(message = "Relay Agent authority store ownership cannot be proven") {
    super(message);
    this.name = "RelayAgentAuthorityStoreOwnershipError";
  }
}

export class RelayAgentAuthorityStoreCommitUncertainError extends Error {
  readonly code = "AGENT_AUTHORITY_STORE_COMMIT_UNCERTAIN" as const;
  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityStoreCommitUncertainError";
  }
}

export class RelayAgentAuthorityStoreCapacityError extends Error {
  readonly code = "AGENT_AUTHORITY_STORE_CAPACITY_EXCEEDED" as const;
  constructor(
    readonly resource: string,
    readonly limit: number,
    readonly attempted: number,
  ) {
    super("Relay Agent authority store capacity is exhausted");
    this.name = "RelayAgentAuthorityStoreCapacityError";
  }
}

export class RelayAgentAuthorityStoreContinuityUnavailableError extends Error {
  readonly code = "AGENT_AUTHORITY_STORE_CONTINUITY_UNAVAILABLE" as const;
  constructor(message = "Relay Agent authority continuity is unavailable") {
    super(message);
    this.name = "RelayAgentAuthorityStoreContinuityUnavailableError";
  }
}

export type RelayAgentTimelineRequestErrorCode =
  | "AGENT_TIMELINE_UNAVAILABLE"
  | "AGENT_CURSOR_EXPIRED"
  | "AGENT_CURSOR_AHEAD"
  | "AGENT_SNAPSHOT_EXPIRED"
  | "AGENT_TIMELINE_EPOCH_MISMATCH";

export class RelayAgentTimelineRequestError extends Error {
  constructor(readonly code: RelayAgentTimelineRequestErrorCode) {
    super("Relay Agent timeline request cannot be satisfied");
    this.name = "RelayAgentTimelineRequestError";
  }
}

const CONTINUITY_ERROR_CODES = new Set<RelayV2ContinuityAnchorErrorCode>([
  "INVALID_CHECKPOINT",
  "INVALID_AUTHORITY_RESPONSE",
  "ANCHOR_UNAVAILABLE",
  "STATE_COMMIT_UNCERTAIN",
  "ANCHOR_COMMIT_UNCERTAIN",
  "LOCAL_STATE_CONFLICT",
  "CAS_CONFLICT",
  "ROLLBACK_DETECTED",
  "RECONCILIATION_REQUIRED",
  "BUSY",
]);

function continuityErrorCode(error: unknown): RelayV2ContinuityAnchorErrorCode | null {
  if (error === null || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CONTINUITY_ERROR_CODES.has(code as RelayV2ContinuityAnchorErrorCode)
    ? code as RelayV2ContinuityAnchorErrorCode
    : null;
}

function mapContinuityError(error: unknown): Error {
  const code = continuityErrorCode(error);
  if (code === null) return error instanceof Error ? error : new Error("unknown continuity failure");
  if (code === "ANCHOR_UNAVAILABLE" || code === "BUSY") {
    return new RelayAgentAuthorityStoreContinuityUnavailableError();
  }
  if (code === "STATE_COMMIT_UNCERTAIN"
    || code === "ANCHOR_COMMIT_UNCERTAIN"
    || code === "RECONCILIATION_REQUIRED") {
    return new RelayAgentAuthorityStoreCommitUncertainError("authority continuity commit requires reconciliation");
  }
  return new RelayAgentAuthorityStoreCorruptError("external continuity rejected local authority state");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function checksum(value: PersistedStoreUnsigned): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sealStore(value: PersistedStoreUnsigned): PersistedStore {
  return { ...value, checksum: checksum(value) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RelayAgentAuthorityStoreCorruptError(`${label} is not an object`);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} does not use its closed schema`);
  }
  return value;
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > 128) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not an opaque ID`);
  }
  return value;
}

function parseContinuityIdentifier(value: unknown, label: string): string {
  const identifier = parseId(value, label);
  if (!CONTINUITY_IDENTIFIER.test(identifier)) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not a continuity identifier`);
  }
  return identifier;
}

function parseCursor(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || value.includes("\0") || Buffer.byteLength(value, "utf8") > 1_024) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not an opaque cursor`);
  }
  return value;
}

function parseCounter(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not a canonical counter`);
  }
  if (BigInt(value) > UINT64_MAX) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} exceeds uint64`);
  }
  return value;
}

function parseInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not a safe non-negative integer`);
  }
  return value as number;
}

function nextCounter(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > UINT64_MAX) throw new RelayAgentAuthorityStoreCorruptError("store commitSeq exhausted");
  return next.toString();
}

function compareCounter(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function checkpointForStore(
  store: PersistedStore,
  exactDurableBytes: Uint8Array,
  anchorId: string,
): RelayV2ContinuityCheckpoint {
  return {
    protocolVersion: RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
    anchorId,
    sequence: store.commitSeq,
    commitId: parseContinuityIdentifier(store.commitId, "store checkpoint commitId"),
    parentCommitId: store.parentCommitId === null
      ? null
      : parseContinuityIdentifier(store.parentCommitId, "store checkpoint parentCommitId"),
    stateDigest: createHash("sha256").update(exactDurableBytes).digest("hex"),
  };
}

function sameCheckpoint(
  left: RelayV2ContinuityCheckpoint,
  right: RelayV2ContinuityCheckpoint,
): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.anchorId === right.anchorId
    && left.sequence === right.sequence
    && left.commitId === right.commitId
    && left.parentCommitId === right.parentCommitId
    && left.stateDigest === right.stateDigest;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sessionKey(value: RelayAgentAuthorityTarget): string {
  return canonicalJson([value.scopeId, value.sessionId]);
}

function cloneStore<T>(value: T): T {
  return structuredClone(value);
}

export function relayAgentAuthorityStorePaths(home = homedir()): RelayAgentAuthorityStorePaths {
  const twHome = join(home, ".tmux-worktree");
  const root = join(twHome, "relay-agent-transcript-lifecycle-v1");
  return {
    state: join(root, "state-v1.json"),
    continuity: join(twHome, "relay-agent-transcript-lifecycle-continuity-v1.json"),
    lock: join(root, "state-v1.lock"),
  };
}

export function relayAgentAuthorityContinuityAnchorId(
  ownerInput: RelayAgentAuthorityStoreOwner,
): string {
  const owner = validateOwner(ownerInput, "continuity anchor owner");
  const digest = createHash("sha256")
    .update(canonicalJson([
      RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      owner.hostId,
      owner.hostEpoch,
    ]), "utf8")
    .digest("hex");
  return `relay-agent-v1:${digest}`;
}

interface PersistedJsonBudgets {
  maximumBytes: number;
  maximumKeys: number;
  maximumNodes: number;
}

interface PreparedStoreCommit {
  store: PersistedStore;
  bytes: Buffer;
  checkpoint: RelayV2ContinuityCheckpoint;
}

interface LoadedStoreCommit {
  store: PersistedStore;
  bytes: Buffer;
  checkpoint: RelayV2ContinuityCheckpoint;
}

interface LocalStoreCommit extends LoadedStoreCommit {
  repairLocalWitness: boolean;
}

function parseStrictJsonBytes(
  bytes: Uint8Array,
  budgets: PersistedJsonBudgets,
  label: string,
  capacityPreflight = false,
): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > budgets.maximumBytes) {
    if (capacityPreflight && bytes.byteLength > budgets.maximumBytes) {
      throw new RelayAgentAuthorityStoreCapacityError(
        "serialized_bytes",
        budgets.maximumBytes,
        bytes.byteLength,
      );
    }
    throw new RelayAgentAuthorityStoreCorruptError(`${label} has an invalid size`);
  }
  try {
    return parseRelayV2JsonObject(decodeRelayV2StrictUtf8(bytes), {
      maxDepth: MAX_STATE_JSON_DEPTH,
      maxDirectKeys: MAX_STATE_JSON_DIRECT_KEYS,
      maxTotalKeys: budgets.maximumKeys,
      maxNodes: budgets.maximumNodes,
    });
  } catch (error) {
    if (capacityPreflight && error instanceof RelayV2JsonError && (
      error.failureClass === "json-depth-limit"
      || error.failureClass === "json-direct-key-limit"
      || error.failureClass === "json-total-key-limit"
      || error.failureClass === "json-node-limit"
    )) {
      const limit = error.failureClass === "json-total-key-limit"
        ? budgets.maximumKeys
        : error.failureClass === "json-node-limit"
          ? budgets.maximumNodes
          : error.failureClass === "json-depth-limit"
            ? MAX_STATE_JSON_DEPTH
            : MAX_STATE_JSON_DIRECT_KEYS;
      throw new RelayAgentAuthorityStoreCapacityError(error.failureClass, limit, limit + 1);
    }
    throw new RelayAgentAuthorityStoreCorruptError(
      `${label} is not strict JSON: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

function parseStrictJsonFile(
  path: string,
  budgets: PersistedJsonBudgets,
): { value: unknown; bytes: Buffer } {
  const expectedSize = lstatSync(path).size;
  if (expectedSize === 0 || expectedSize > budgets.maximumBytes) {
    throw new RelayAgentAuthorityStoreCorruptError(`${basename(path)} has an invalid size`);
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength !== expectedSize) {
    throw new RelayAgentAuthorityStoreCorruptError(`${basename(path)} has an invalid size`);
  }
  return {
    value: parseStrictJsonBytes(bytes, budgets, basename(path)),
    bytes,
  };
}

function assertOwnedRegularFile(path: string): void {
  const information = lstatSync(path);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new RelayAgentAuthorityStoreOwnershipError(`${basename(path)} is not an owned regular file`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && information.uid !== uid) {
    throw new RelayAgentAuthorityStoreOwnershipError(`${basename(path)} has an unexpected owner`);
  }
  chmodSync(path, 0o600);
}

function fsyncDirectorySync(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertOwnedDirectory(path: string, harden: boolean): void {
  const information = lstatSync(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new RelayAgentAuthorityStoreOwnershipError(`${basename(path)} is not an owned directory`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && information.uid !== uid) {
    throw new RelayAgentAuthorityStoreOwnershipError(`${basename(path)} has an unexpected owner`);
  }
  if (harden) chmodSync(path, 0o700);
}

function ensurePrivateDirectory(path: string, fsyncDirectory: (path: string) => void): void {
  if (existsSync(path)) {
    assertOwnedDirectory(path, true);
    return;
  }
  const parent = dirname(path);
  if (!existsSync(parent)) ensurePrivateDirectory(parent, fsyncDirectory);
  else assertOwnedDirectory(parent, false);
  mkdirSync(path, { mode: 0o700 });
  assertOwnedDirectory(path, true);
  fsyncDirectory(path);
  fsyncDirectory(parent);
}

function validateOwner(value: unknown, label: string): RelayAgentAuthorityStoreOwner {
  const owner = exactRecord(value, ["hostId", "hostEpoch"], label);
  return {
    hostId: parseId(owner.hostId, `${label}.hostId`),
    hostEpoch: parseId(owner.hostEpoch, `${label}.hostEpoch`),
  };
}

function sameOwner(left: RelayAgentAuthorityStoreOwner, right: RelayAgentAuthorityStoreOwner): boolean {
  return left.hostId === right.hostId && left.hostEpoch === right.hostEpoch;
}

function validateTarget(value: RelayAgentAuthorityTarget): RelayAgentAuthorityTarget {
  return {
    scopeId: parseId(value.scopeId, "target.scopeId"),
    sessionId: parseId(value.sessionId, "target.sessionId"),
  };
}

function validatePublicEvent(
  value: unknown,
  owner: RelayAgentAuthorityStoreOwner,
  target: RelayAgentAuthorityTarget,
  timelineEpoch: string,
  label: string,
): RelayAgentAuthorityPublicEvent {
  const event = exactRecord(value, [
    "hostId", "hostEpoch", "scopeId", "sessionId", "timelineEpoch",
    "agentEventSeq", "eventId", "occurredAtMs", "mutation",
  ], label) as unknown as RelayAgentAuthorityPublicEvent;
  const frame = {
    protocolVersion: 2,
    kind: "event",
    type: "agent.timeline.event",
    hostId: owner.hostId,
    hostEpoch: owner.hostEpoch,
    scopeId: target.scopeId,
    sessionId: target.sessionId,
    payload: {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      timelineEpoch,
      agentEventSeq: event.agentEventSeq,
      eventId: event.eventId,
      occurredAtMs: event.occurredAtMs,
      mutation: event.mutation,
    },
  } as unknown as RelayV2JsonObject;
  try {
    validateRelayAgentTranscriptLifecycleFrame(frame);
  } catch {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not a valid public event`);
  }
  if (
    event.hostId !== owner.hostId
    || event.hostEpoch !== owner.hostEpoch
    || event.scopeId !== target.scopeId
    || event.sessionId !== target.sessionId
    || event.timelineEpoch !== timelineEpoch
  ) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} lineage does not match its store`);
  }
  return event;
}

interface SnapshotWireContext {
  owner: RelayAgentAuthorityStoreOwner;
  target: RelayAgentAuthorityTarget;
  timelineEpoch: string;
  snapshotRequestId: string;
  snapshotId: string;
  throughAgentSeq: string;
  earliestRetainedSeq: string;
}

interface ReplayWireContext {
  owner: RelayAgentAuthorityStoreOwner;
  target: RelayAgentAuthorityTarget;
  timelineEpoch: string;
  afterAgentSeq: string;
  replayThroughAgentSeq: string;
}

function snapshotPageFrame(
  context: SnapshotWireContext,
  pageIndex: number,
  records: readonly (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[],
  nextCursor: string | null,
): RelayV2JsonObject {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "agent.timeline.snapshot.page",
    requestId: WORST_CASE_WIRE_REQUEST_ID,
    hostId: context.owner.hostId,
    hostEpoch: context.owner.hostEpoch,
    scopeId: context.target.scopeId,
    sessionId: context.target.sessionId,
    payload: {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      timelineEpoch: context.timelineEpoch,
      snapshotRequestId: context.snapshotRequestId,
      snapshotId: context.snapshotId,
      pageIndex,
      isLast: nextCursor === null,
      nextCursor,
      throughAgentSeq: context.throughAgentSeq,
      earliestRetainedSeq: context.earliestRetainedSeq,
      records,
    },
  } as unknown as RelayV2JsonObject;
}

function replayPageFrame(
  context: ReplayWireContext,
  events: readonly RelayAgentAuthorityPublicEvent[],
  nextCursor: string | null,
): RelayV2JsonObject {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "agent.timeline.replay.page",
    requestId: WORST_CASE_WIRE_REQUEST_ID,
    hostId: context.owner.hostId,
    hostEpoch: context.owner.hostEpoch,
    scopeId: context.target.scopeId,
    sessionId: context.target.sessionId,
    payload: {
      capability: RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
      timelineEpoch: context.timelineEpoch,
      afterAgentSeq: context.afterAgentSeq,
      replayThroughAgentSeq: context.replayThroughAgentSeq,
      isLast: nextCursor === null,
      nextCursor,
      events: events.map(toReplayEvent),
    },
  } as unknown as RelayV2JsonObject;
}

function frameFitsWire(frame: RelayV2JsonObject): boolean {
  try {
    encodeRelayAgentTranscriptLifecycleFrame(frame);
    return true;
  } catch {
    return false;
  }
}

function assertFrozenWireFrame(frame: RelayV2JsonObject, label: string): void {
  try {
    encodeRelayAgentTranscriptLifecycleFrame(frame);
  } catch {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} is not a wire-encodable frozen page`);
  }
}

function freezeSnapshotRecordPages(
  context: SnapshotWireContext,
  records: readonly (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[],
): (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[][] {
  if (records.length === 0) return [[]];
  const pages: (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[][] = [];
  let page: (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[] = [];
  for (const record of records) {
    const candidate = [...page, record];
    if (candidate.length <= RELAY_AGENT_MAX_PAGE_RECORDS && frameFitsWire(snapshotPageFrame(
      context,
      Number.MAX_SAFE_INTEGER,
      candidate,
      WORST_CASE_WIRE_CURSOR,
    ))) {
      page = candidate;
      continue;
    }
    if (page.length === 0) {
      throw new RelayAgentAuthorityStoreCapacityError("snapshot_wire_page", 1, 1);
    }
    pages.push(page);
    page = [record];
    if (!frameFitsWire(snapshotPageFrame(
      context,
      Number.MAX_SAFE_INTEGER,
      page,
      WORST_CASE_WIRE_CURSOR,
    ))) {
      throw new RelayAgentAuthorityStoreCapacityError("snapshot_wire_page", 1, 1);
    }
  }
  pages.push(page);
  return pages;
}

function freezeReplayEventPages(
  context: ReplayWireContext,
  events: readonly RelayAgentAuthorityPublicEvent[],
  limit: number,
): RelayAgentAuthorityPublicEvent[][] {
  if (events.length === 0) return [[]];
  const pages: RelayAgentAuthorityPublicEvent[][] = [];
  let page: RelayAgentAuthorityPublicEvent[] = [];
  for (const event of events) {
    const candidate = [...page, event];
    if (candidate.length <= limit && frameFitsWire(replayPageFrame(
      context,
      candidate,
      WORST_CASE_WIRE_CURSOR,
    ))) {
      page = candidate;
      continue;
    }
    if (page.length === 0) {
      throw new RelayAgentAuthorityStoreCapacityError("replay_wire_page", 1, 1);
    }
    pages.push(page);
    page = [event];
    if (!frameFitsWire(replayPageFrame(context, page, WORST_CASE_WIRE_CURSOR))) {
      throw new RelayAgentAuthorityStoreCapacityError("replay_wire_page", 1, 1);
    }
  }
  pages.push(page);
  return pages;
}

function validateSnapshotRecordOrder(
  records: readonly (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[],
  label: string,
): void {
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    const previousSeq = previous.recordType === "lifecycle" ? previous.agentEventSeq : previous.createdAgentSeq;
    const currentSeq = current.recordType === "lifecycle" ? current.agentEventSeq : current.createdAgentSeq;
    const previousId = previous.recordType === "lifecycle" ? previous.lifecycleEventId : previous.entryId;
    const currentId = current.recordType === "lifecycle" ? current.lifecycleEventId : current.entryId;
    if (compareCounter(previousSeq, currentSeq) > 0
      || (previousSeq === currentSeq && compareUtf8(previousId, currentId) >= 0)) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label} is not globally ordered`);
    }
  }
}

function validateSnapshotCutPages(
  cut: PersistedSnapshotCut,
  owner: RelayAgentAuthorityStoreOwner,
  target: RelayAgentAuthorityTarget,
  timelineEpoch: string,
  label: string,
): void {
  if (cut.recordPages.length === 0) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} has no frozen pages`);
  }
  const context: SnapshotWireContext = {
    owner,
    target,
    timelineEpoch,
    snapshotRequestId: cut.snapshotRequestId,
    snapshotId: cut.snapshotId,
    throughAgentSeq: cut.throughAgentSeq,
    earliestRetainedSeq: cut.earliestRetainedSeq,
  };
  for (let pageIndex = 0; pageIndex < cut.recordPages.length; pageIndex += 1) {
    const records = cut.recordPages[pageIndex]!;
    if (records.length > RELAY_AGENT_MAX_PAGE_RECORDS
      || (records.length === 0 && cut.recordPages.length !== 1)) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}[${pageIndex}] has an invalid record count`);
    }
    assertFrozenWireFrame(snapshotPageFrame(
      context,
      pageIndex,
      records,
      pageIndex < cut.pageCursors.length ? cut.pageCursors[pageIndex]! : null,
    ), `${label}[${pageIndex}]`);
  }
  validateSnapshotRecordOrder(cut.recordPages.flat(), label);
}

function validateReplayCutPages(
  cut: PersistedReplayCut,
  owner: RelayAgentAuthorityStoreOwner,
  target: RelayAgentAuthorityTarget,
  timelineEpoch: string,
  label: string,
): void {
  if (cut.eventPages.length === 0) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} has no frozen pages`);
  }
  const context: ReplayWireContext = {
    owner,
    target,
    timelineEpoch,
    afterAgentSeq: cut.afterAgentSeq,
    replayThroughAgentSeq: cut.replayThroughAgentSeq,
  };
  for (let pageIndex = 0; pageIndex < cut.eventPages.length; pageIndex += 1) {
    const events = cut.eventPages[pageIndex]!;
    if (events.length > cut.limit || (events.length === 0 && cut.eventPages.length !== 1)) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}[${pageIndex}] has an invalid event count`);
    }
    assertFrozenWireFrame(replayPageFrame(
      context,
      events,
      pageIndex < cut.pageCursors.length ? cut.pageCursors[pageIndex]! : null,
    ), `${label}[${pageIndex}]`);
  }
}

function validateUniqueCursors(value: unknown, expected: number, label: string): string[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} has an invalid cursor count`);
  }
  const cursors = value.map((item, index) => parseCursor(item, `${label}[${index}]`));
  if (new Set(cursors).size !== cursors.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} contains duplicate cursors`);
  }
  return cursors;
}

function validateTimeline(
  value: unknown,
  owner: RelayAgentAuthorityStoreOwner,
  target: RelayAgentAuthorityTarget,
  label: string,
): PersistedTimeline {
  const timeline = exactRecord(value, [
    "timelineEpoch", "authority", "dedupeRetention", "events", "snapshots",
    "snapshotTombstones", "replayCuts",
  ], label);
  const timelineEpoch = parseId(timeline.timelineEpoch, `${label}.timelineEpoch`);
  const binding: RelayAgentAuthorityBinding = { ...owner, ...target, timelineEpoch };
  let authority;
  try {
    authority = restoreRelayAgentAuthorityState(timeline.authority, binding);
  } catch {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.authority cannot be restored`);
  }
  const authoritySnapshot = snapshotRelayAgentAuthorityState(authority);

  if (!Array.isArray(timeline.dedupeRetention)
    || timeline.dedupeRetention.length > authoritySnapshot.limits.maxDedupeEvidenceCount) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.dedupeRetention is invalid`);
  }
  const dedupeRetention = timeline.dedupeRetention.map((item, index) => {
    const record = exactRecord(item, ["sourceEpoch", "sourceEventId", "committedAtMs"], `${label}.dedupeRetention[${index}]`);
    return {
      sourceEpoch: parseId(record.sourceEpoch, `${label}.dedupeRetention[${index}].sourceEpoch`),
      sourceEventId: parseId(record.sourceEventId, `${label}.dedupeRetention[${index}].sourceEventId`),
      committedAtMs: parseInteger(record.committedAtMs, `${label}.dedupeRetention[${index}].committedAtMs`),
    };
  });
  const dedupeKeys = dedupeRetention.map((item) => canonicalJson([item.sourceEpoch, item.sourceEventId]));
  const authorityDedupeKeys = authoritySnapshot.dedupe.map((item) => canonicalJson([
    item.value.sourceEpoch, item.value.sourceEventId,
  ]));
  if (new Set(dedupeKeys).size !== dedupeKeys.length
    || [...dedupeKeys].sort(compareUtf8).join("\n") !== [...authorityDedupeKeys].sort(compareUtf8).join("\n")) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} dedupe retention/evidence mismatch`);
  }

  if (!Array.isArray(timeline.events) || timeline.events.length > MAX_PUBLIC_EVENTS_PER_TIMELINE) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.events is invalid`);
  }
  const events = timeline.events.map((item, index) => {
    const record = exactRecord(item, ["committedAtMs", "event"], `${label}.events[${index}]`);
    return {
      committedAtMs: parseInteger(record.committedAtMs, `${label}.events[${index}].committedAtMs`),
      event: validatePublicEvent(record.event, owner, target, timelineEpoch, `${label}.events[${index}].event`),
    };
  });
  if (new Set(events.map((item) => item.event.eventId)).size !== events.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.events reuses a public event ID`);
  }
  for (let index = 0; index < events.length; index += 1) {
    if (index > 0 && BigInt(events[index]!.event.agentEventSeq) !== BigInt(events[index - 1]!.event.agentEventSeq) + 1n) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.events is not a contiguous suffix`);
    }
    if (compareCounter(events[index]!.event.agentEventSeq, authority.agentEventSeq) > 0) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.events is ahead of authority`);
    }
  }
  if (events.length > 0 && events.at(-1)!.event.agentEventSeq !== authority.agentEventSeq) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.events does not end at current authority sequence`);
  }

  if (!Array.isArray(timeline.snapshots)) throw new RelayAgentAuthorityStoreCorruptError(`${label}.snapshots is invalid`);
  const snapshots = timeline.snapshots.map((item, index) => {
    const record = exactRecord(item, [
      "principalId", "clientInstanceId", "snapshotRequestId", "snapshotId", "createdAtMs",
      "expiresAtMs", "throughAgentSeq", "earliestRetainedSeq", "recordPages", "pageCursors",
    ], `${label}.snapshots[${index}]`);
    if (!Array.isArray(record.recordPages)) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.snapshots[${index}].recordPages is invalid`);
    }
    const recordPages = record.recordPages.map((page, pageIndex) => {
      if (!Array.isArray(page)) {
        throw new RelayAgentAuthorityStoreCorruptError(
          `${label}.snapshots[${index}].recordPages[${pageIndex}] is invalid`,
        );
      }
      return page as (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[];
    });
    const cut: PersistedSnapshotCut = {
      principalId: parseId(record.principalId, `${label}.snapshots[${index}].principalId`),
      clientInstanceId: parseId(record.clientInstanceId, `${label}.snapshots[${index}].clientInstanceId`),
      snapshotRequestId: parseId(record.snapshotRequestId, `${label}.snapshots[${index}].snapshotRequestId`),
      snapshotId: parseId(record.snapshotId, `${label}.snapshots[${index}].snapshotId`),
      createdAtMs: parseInteger(record.createdAtMs, `${label}.snapshots[${index}].createdAtMs`),
      expiresAtMs: parseInteger(record.expiresAtMs, `${label}.snapshots[${index}].expiresAtMs`),
      throughAgentSeq: parseCounter(record.throughAgentSeq, `${label}.snapshots[${index}].throughAgentSeq`),
      earliestRetainedSeq: parseCounter(record.earliestRetainedSeq, `${label}.snapshots[${index}].earliestRetainedSeq`),
      recordPages,
      pageCursors: validateUniqueCursors(
        record.pageCursors,
        Math.max(0, recordPages.length - 1),
        `${label}.snapshots[${index}].pageCursors`,
      ),
    };
    if (cut.expiresAtMs < cut.createdAtMs
      || compareCounter(cut.earliestRetainedSeq, cut.throughAgentSeq) > 0
      || compareCounter(cut.throughAgentSeq, authority.agentEventSeq) > 0) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.snapshots[${index}] has invalid watermarks`);
    }
    validateSnapshotCutPages(
      cut,
      owner,
      target,
      timelineEpoch,
      `${label}.snapshots[${index}].recordPages`,
    );
    return cut;
  });

  if (!Array.isArray(timeline.snapshotTombstones)) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label}.snapshotTombstones is invalid`);
  }
  const snapshotTombstones = timeline.snapshotTombstones.map((item, index) => {
    const record = exactRecord(item, [
      "principalId", "clientInstanceId", "snapshotRequestId", "snapshotId", "expiresAtMs",
    ], `${label}.snapshotTombstones[${index}]`);
    return {
      principalId: parseId(record.principalId, `${label}.snapshotTombstones[${index}].principalId`),
      clientInstanceId: parseId(record.clientInstanceId, `${label}.snapshotTombstones[${index}].clientInstanceId`),
      snapshotRequestId: parseId(record.snapshotRequestId, `${label}.snapshotTombstones[${index}].snapshotRequestId`),
      snapshotId: parseId(record.snapshotId, `${label}.snapshotTombstones[${index}].snapshotId`),
      expiresAtMs: parseInteger(record.expiresAtMs, `${label}.snapshotTombstones[${index}].expiresAtMs`),
    };
  });

  if (!Array.isArray(timeline.replayCuts)) throw new RelayAgentAuthorityStoreCorruptError(`${label}.replayCuts is invalid`);
  const replayCuts = timeline.replayCuts.map((item, index) => {
    const record = exactRecord(item, [
      "principalId", "clientInstanceId", "afterAgentSeq", "limit", "replayThroughAgentSeq",
      "createdAtMs", "expiresAtMs", "eventPages", "pageCursors",
    ], `${label}.replayCuts[${index}]`);
    const afterAgentSeq = parseCounter(record.afterAgentSeq, `${label}.replayCuts[${index}].afterAgentSeq`);
    const replayThroughAgentSeq = parseCounter(record.replayThroughAgentSeq, `${label}.replayCuts[${index}].replayThroughAgentSeq`);
    const limit = parseInteger(record.limit, `${label}.replayCuts[${index}].limit`);
    if (limit < 1 || limit > RELAY_AGENT_MAX_PAGE_RECORDS || !Array.isArray(record.eventPages)) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.replayCuts[${index}] has invalid paging`);
    }
    const eventPages = record.eventPages.map((page, pageIndex) => {
      if (!Array.isArray(page)) {
        throw new RelayAgentAuthorityStoreCorruptError(
          `${label}.replayCuts[${index}].eventPages[${pageIndex}] is invalid`,
        );
      }
      return page.map((event, eventIndex) => validatePublicEvent(
        event,
        owner,
        target,
        timelineEpoch,
        `${label}.replayCuts[${index}].eventPages[${pageIndex}][${eventIndex}]`,
      ));
    });
    const replayEvents = eventPages.flat();
    let expected = BigInt(afterAgentSeq);
    for (const event of replayEvents) {
      expected += 1n;
      if (event.agentEventSeq !== expected.toString()) {
        throw new RelayAgentAuthorityStoreCorruptError(`${label}.replayCuts[${index}] is not contiguous`);
      }
    }
    if ((replayEvents.length === 0 && afterAgentSeq !== replayThroughAgentSeq)
      || (replayEvents.length > 0 && replayEvents.at(-1)!.agentEventSeq !== replayThroughAgentSeq)
      || compareCounter(replayThroughAgentSeq, authority.agentEventSeq) > 0) {
      throw new RelayAgentAuthorityStoreCorruptError(`${label}.replayCuts[${index}] has invalid watermarks`);
    }
    const createdAtMs = parseInteger(record.createdAtMs, `${label}.replayCuts[${index}].createdAtMs`);
    const expiresAtMs = parseInteger(record.expiresAtMs, `${label}.replayCuts[${index}].expiresAtMs`);
    if (expiresAtMs < createdAtMs) throw new RelayAgentAuthorityStoreCorruptError(`${label}.replayCuts[${index}] expired before creation`);
    const cut: PersistedReplayCut = {
      principalId: parseId(record.principalId, `${label}.replayCuts[${index}].principalId`),
      clientInstanceId: parseId(record.clientInstanceId, `${label}.replayCuts[${index}].clientInstanceId`),
      afterAgentSeq,
      limit,
      replayThroughAgentSeq,
      createdAtMs,
      expiresAtMs,
      eventPages,
      pageCursors: validateUniqueCursors(
        record.pageCursors,
        Math.max(0, eventPages.length - 1),
        `${label}.replayCuts[${index}].pageCursors`,
      ),
    };
    validateReplayCutPages(
      cut,
      owner,
      target,
      timelineEpoch,
      `${label}.replayCuts[${index}].eventPages`,
    );
    return cut;
  });

  const allCursorValues = [
    ...snapshots.flatMap((item) => item.pageCursors),
    ...replayCuts.flatMap((item) => item.pageCursors),
  ];
  if (new Set(allCursorValues).size !== allCursorValues.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} reuses an opaque cursor`);
  }
  if (new Set(snapshots.map((item) => item.snapshotId)).size !== snapshots.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} reuses a snapshot ID`);
  }
  const snapshotLogicalKeys = snapshots.map((item) => canonicalJson([
    item.principalId, item.clientInstanceId, item.snapshotRequestId,
  ]));
  if (new Set(snapshotLogicalKeys).size !== snapshotLogicalKeys.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} reuses a logical snapshot request`);
  }
  const replayLogicalKeys = replayCuts.map((item) => canonicalJson([
    item.principalId, item.clientInstanceId, item.afterAgentSeq, item.limit,
  ]));
  if (new Set(replayLogicalKeys).size !== replayLogicalKeys.length) {
    throw new RelayAgentAuthorityStoreCorruptError(`${label} reuses a logical replay cut`);
  }
  return { timelineEpoch, authority: authoritySnapshot, dedupeRetention, events, snapshots, snapshotTombstones, replayCuts };
}

function validateStore(value: unknown, expectedOwner: RelayAgentAuthorityStoreOwner): PersistedStore {
  const root = exactRecord(value, [
    "version", "owner", "policy", "commitSeq", "commitId", "parentCommitId",
    "lastObservedAtMs", "sessions", "checksum",
  ], "authority store");
  if (root.version !== RELAY_AGENT_AUTHORITY_STORE_VERSION) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store version is unknown");
  }
  const owner = validateOwner(root.owner, "authority store.owner");
  if (!sameOwner(owner, expectedOwner)) {
    throw new RelayAgentAuthorityStoreOwnershipError("authority store owner/host lineage mismatch");
  }
  const policyRecord = exactRecord(
    root.policy,
    ["eventReplayRetentionMs", "snapshotLeaseMs"],
    "authority store.policy",
  );
  const eventReplayRetentionMs = parseInteger(
    policyRecord.eventReplayRetentionMs,
    "authority store.policy.eventReplayRetentionMs",
  );
  if (eventReplayRetentionMs < RELAY_AGENT_MIN_REPLAY_RETENTION_MS) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store replay retention is below the frozen minimum");
  }
  if (policyRecord.snapshotLeaseMs !== RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store snapshot lease is unknown");
  }
  const commitSeq = parseCounter(root.commitSeq, "authority store.commitSeq");
  const commitId = parseContinuityIdentifier(root.commitId, "authority store.commitId");
  const parentCommitId = root.parentCommitId === null
    ? null
    : parseContinuityIdentifier(root.parentCommitId, "authority store.parentCommitId");
  if ((commitSeq === "0") !== (parentCommitId === null)) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store commit lineage is malformed");
  }
  const lastObservedAtMs = parseInteger(root.lastObservedAtMs, "authority store.lastObservedAtMs");
  if (!Array.isArray(root.sessions) || root.sessions.length > MAX_SESSION_COUNT) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store session collection is invalid");
  }
  const sessions = root.sessions.map((item, index): PersistedSession => {
    const record = exactRecord(
      item,
      ["scopeId", "sessionId", "support", "unavailableReason", "timeline"],
      `authority store.sessions[${index}]`,
    );
    const target = {
      scopeId: parseId(record.scopeId, `authority store.sessions[${index}].scopeId`),
      sessionId: parseId(record.sessionId, `authority store.sessions[${index}].sessionId`),
    };
    if (record.support !== "available" && record.support !== "unavailable") {
      throw new RelayAgentAuthorityStoreCorruptError(`authority store.sessions[${index}].support is invalid`);
    }
    const allowedReasons = new Set(["agent_unsupported", "session_not_agent_managed", "adapter_unavailable"]);
    const unavailableReason = record.unavailableReason === null
      ? null
      : parseId(record.unavailableReason, `authority store.sessions[${index}].unavailableReason`);
    if ((record.support === "available") !== (unavailableReason === null)
      || (unavailableReason !== null && !allowedReasons.has(unavailableReason))) {
      throw new RelayAgentAuthorityStoreCorruptError(`authority store.sessions[${index}] support/reason mismatch`);
    }
    const timeline = record.timeline === null
      ? null
      : validateTimeline(record.timeline, owner, target, `authority store.sessions[${index}].timeline`);
    if (record.support === "available" && (timeline === null
      || timeline.authority.activeSourceEpoch === null
      || timeline.authority.activeSourceAvailability === null)) {
      throw new RelayAgentAuthorityStoreCorruptError(`authority store.sessions[${index}] has no active source`);
    }
    return {
      ...target,
      support: record.support,
      unavailableReason: unavailableReason as PersistedSession["unavailableReason"],
      timeline,
    };
  });
  const keys = sessions.map(sessionKey);
  if (new Set(keys).size !== keys.length
    || keys.some((key, index) => index > 0 && compareUtf8(keys[index - 1]!, key) >= 0)) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store sessions are not uniquely ordered");
  }
  if (sessions.reduce((count, item) => count + (item.timeline?.snapshots.length ?? 0), 0) > MAX_SNAPSHOTS_PER_STORE
    || sessions.reduce((count, item) => count + (item.timeline?.replayCuts.length ?? 0), 0) > MAX_REPLAY_CUTS_PER_STORE
    || sessions.reduce((count, item) => count + (item.timeline?.snapshotTombstones.length ?? 0), 0) > MAX_SNAPSHOT_TOMBSTONES_PER_STORE) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store durable cut budget is exceeded");
  }
  const snapshotsByPrincipal = new Map<string, number>();
  for (const session of sessions) {
    for (const cut of session.timeline?.snapshots ?? []) {
      snapshotsByPrincipal.set(cut.principalId, (snapshotsByPrincipal.get(cut.principalId) ?? 0) + 1);
    }
  }
  if ([...snapshotsByPrincipal.values()].some((count) => count > MAX_SNAPSHOTS_PER_PRINCIPAL)) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store principal snapshot budget is exceeded");
  }
  const unsigned: PersistedStoreUnsigned = {
    version: RELAY_AGENT_AUTHORITY_STORE_VERSION,
    owner,
    policy: {
      eventReplayRetentionMs,
      snapshotLeaseMs: RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
    },
    commitSeq,
    commitId,
    parentCommitId,
    lastObservedAtMs,
    sessions,
  };
  if (typeof root.checksum !== "string" || root.checksum !== checksum(unsigned)) {
    throw new RelayAgentAuthorityStoreCorruptError("authority store checksum does not match its content");
  }
  return { ...unsigned, checksum: root.checksum };
}

function validateContinuity(value: unknown, expectedOwner: RelayAgentAuthorityStoreOwner): ContinuityWitness {
  const root = exactRecord(
    value,
    ["version", "owner", "commitSeq", "commitId", "stateChecksum"],
    "authority continuity witness",
  );
  if (root.version !== RELAY_AGENT_AUTHORITY_CONTINUITY_VERSION) {
    throw new RelayAgentAuthorityStoreCorruptError("authority continuity version is unknown");
  }
  const owner = validateOwner(root.owner, "authority continuity witness.owner");
  if (!sameOwner(owner, expectedOwner)) {
    throw new RelayAgentAuthorityStoreOwnershipError("authority continuity owner/host lineage mismatch");
  }
  const stateChecksum = root.stateChecksum;
  if (typeof stateChecksum !== "string" || !/^[a-f0-9]{64}$/.test(stateChecksum)) {
    throw new RelayAgentAuthorityStoreCorruptError("authority continuity checksum is malformed");
  }
  return {
    version: RELAY_AGENT_AUTHORITY_CONTINUITY_VERSION,
    owner,
    commitSeq: parseCounter(root.commitSeq, "authority continuity witness.commitSeq"),
    commitId: parseId(root.commitId, "authority continuity witness.commitId"),
    stateChecksum,
  };
}

function inspectJsonFile<T>(
  path: string,
  budgets: PersistedJsonBudgets,
  validator: (value: unknown) => T,
): FileInspection<T> {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    assertOwnedRegularFile(path);
    const parsed = parseStrictJsonFile(path, budgets);
    return { kind: "valid", value: validator(parsed.value), bytes: parsed.bytes };
  } catch (error) {
    if (error instanceof RelayAgentAuthorityStoreOwnershipError) throw error;
    return { kind: "invalid" };
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("short write");
    offset += written;
  }
}

function atomicWritePrivateBytes(
  path: string,
  bytes: Buffer,
  renameFile: (source: string, destination: string) => void,
  maximumBytes: number,
  fsyncDirectory: (path: string) => void,
): void {
  ensurePrivateDirectory(dirname(path), fsyncDirectory);
  if (bytes.byteLength > maximumBytes) {
    throw new RelayAgentAuthorityStoreCapacityError("serialized_bytes", maximumBytes, bytes.byteLength);
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let fd: number | null = null;
  let published = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameFile(temporary, path);
    published = true;
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (!published && existsSync(path)) {
      try {
        published = readFileSync(path).equals(bytes);
      } catch {
        // The caller still treats this as an unpublished failure.
      }
    }
    throw new AtomicPublishError(path, published, error);
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function atomicWritePrivateJson(
  path: string,
  value: unknown,
  renameFile: (source: string, destination: string) => void,
  maximumBytes: number,
  fsyncDirectory: (path: string) => void,
): void {
  atomicWritePrivateBytes(
    path,
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    renameFile,
    maximumBytes,
    fsyncDirectory,
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitBriefly(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseLockOwner(path: string): StoreLockOwner {
  assertOwnedRegularFile(path);
  const value = parseStrictJsonFile(path, {
    maximumBytes: MAX_CONTINUITY_BYTES,
    maximumKeys: 32,
    maximumNodes: 64,
  }).value;
  const owner = exactRecord(value, ["owner", "pid", "createdAtMs"], "authority store lock owner");
  return {
    owner: parseId(owner.owner, "authority store lock owner.owner"),
    pid: parseInteger(owner.pid, "authority store lock owner.pid"),
    createdAtMs: parseInteger(owner.createdAtMs, "authority store lock owner.createdAtMs"),
  };
}

function acquireStoreLock(
  path: string,
  now: () => number,
  randomId: () => string,
  fsyncDirectory: (path: string) => void,
): StoreLock {
  ensurePrivateDirectory(dirname(path), fsyncDirectory);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner = randomId();
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(dirname(path));
      writeFileSync(join(path, LOCK_OWNER_FILE), JSON.stringify({
        owner,
        pid: process.pid,
        createdAtMs: now(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const fd = openSync(join(path, LOCK_OWNER_FILE), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { path, owner };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        throw new RelayAgentAuthorityStoreOwnershipError("authority store lock could not be established");
      }
      let current: StoreLockOwner;
      try {
        const information = lstatSync(path);
        if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("invalid lock directory");
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        if (uid !== null && information.uid !== uid) throw new Error("invalid lock owner");
        chmodSync(path, 0o700);
        current = parseLockOwner(join(path, LOCK_OWNER_FILE));
      } catch {
        throw new RelayAgentAuthorityStoreOwnershipError("authority store lock ownership cannot be proven");
      }
      if (now() - current.createdAtMs > LOCK_STALE_MS && !processIsAlive(current.pid)) {
        const quarantine = `${path}.stale.${randomBytes(12).toString("hex")}`;
        try {
          renameSync(path, quarantine);
          rmSync(quarantine, { recursive: true, force: true });
          continue;
        } catch {
          // A concurrent contender won; inspect the new lock on the next pass.
        }
      }
      if (Date.now() >= deadline) {
        throw new RelayAgentAuthorityStoreOwnershipError("authority store lock wait timed out");
      }
      waitBriefly(20);
    }
  }
}

function releaseStoreLock(lock: StoreLock): void {
  if (!existsSync(lock.path)) return;
  try {
    const owner = parseLockOwner(join(lock.path, LOCK_OWNER_FILE));
    if (owner.owner !== lock.owner) return;
    rmSync(lock.path, { recursive: true, force: true });
  } catch {
    // Never delete a lock whose ownership cannot be re-proven.
  }
}

function freshStore(
  owner: RelayAgentAuthorityStoreOwner,
  eventReplayRetentionMs: number,
  commitId: string,
  observedAtMs: number,
): PersistedStore {
  return sealStore({
    version: RELAY_AGENT_AUTHORITY_STORE_VERSION,
    owner: { ...owner },
    policy: {
      eventReplayRetentionMs,
      snapshotLeaseMs: RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
    },
    commitSeq: "0",
    commitId,
    parentCommitId: null,
    lastObservedAtMs: observedAtMs,
    sessions: [],
  });
}

function continuityFor(store: PersistedStore): ContinuityWitness {
  return {
    version: RELAY_AGENT_AUTHORITY_CONTINUITY_VERSION,
    owner: { ...store.owner },
    commitSeq: store.commitSeq,
    commitId: store.commitId,
    stateChecksum: store.checksum,
  };
}

function findSession(store: PersistedStore, target: RelayAgentAuthorityTarget): PersistedSession | undefined {
  return store.sessions.find((item) => item.scopeId === target.scopeId && item.sessionId === target.sessionId);
}

function sortSessions(store: PersistedStore): void {
  store.sessions.sort((left, right) => compareUtf8(sessionKey(left), sessionKey(right)));
}

function replayFloor(timeline: PersistedTimeline): string {
  return timeline.events.length > 0
    ? timeline.events[0]!.event.agentEventSeq
    : timeline.authority.agentEventSeq;
}

function snapshotSortKey(record: RelayAgentLifecycleRecord | RelayAgentTextEntryRecord): readonly [string, string] {
  return record.recordType === "lifecycle"
    ? [record.agentEventSeq, record.lifecycleEventId]
    : [record.createdAgentSeq, record.entryId];
}

function materializedRecords(timeline: PersistedTimeline): (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[] {
  const records: (RelayAgentLifecycleRecord | RelayAgentTextEntryRecord)[] = [
    ...timeline.authority.runs.map((item) => cloneStore(item.value.lifecycle)),
    ...timeline.authority.turns.map((item) => cloneStore(item.value.lifecycle)),
    ...timeline.authority.entries.map((item) => cloneStore(item.value)),
  ];
  records.sort((left, right) => {
    const a = snapshotSortKey(left);
    const b = snapshotSortKey(right);
    const sequenceOrder = compareCounter(a[0], b[0]);
    return sequenceOrder !== 0 ? sequenceOrder : compareUtf8(a[1], b[1]);
  });
  return records;
}

function toReplayEvent(event: RelayAgentAuthorityPublicEvent): RelayAgentReplayEvent {
  return {
    agentEventSeq: event.agentEventSeq,
    eventId: event.eventId,
    occurredAtMs: event.occurredAtMs,
    mutation: cloneStore(event.mutation),
  };
}

function dedupeRetentionKey(item: Pick<PersistedSourceDedupeRetention, "sourceEpoch" | "sourceEventId">): string {
  return canonicalJson([item.sourceEpoch, item.sourceEventId]);
}

function pruneStore(store: PersistedStore, observedAtMs: number): boolean {
  let changed = false;
  const eventCutoff = Math.max(0, observedAtMs - store.policy.eventReplayRetentionMs);
  for (const session of store.sessions) {
    const timeline = session.timeline;
    if (timeline === null) continue;

    const activeSnapshots: PersistedSnapshotCut[] = [];
    for (const cut of timeline.snapshots) {
      if (cut.expiresAtMs <= observedAtMs) {
        timeline.snapshotTombstones.push({
          principalId: cut.principalId,
          clientInstanceId: cut.clientInstanceId,
          snapshotRequestId: cut.snapshotRequestId,
          snapshotId: cut.snapshotId,
          expiresAtMs: Math.min(MAX_SAFE_INTEGER, observedAtMs + store.policy.eventReplayRetentionMs),
        });
        changed = true;
      } else {
        activeSnapshots.push(cut);
      }
    }
    timeline.snapshots = activeSnapshots;
    const tombstones = timeline.snapshotTombstones.filter((item) => item.expiresAtMs > observedAtMs);
    if (tombstones.length !== timeline.snapshotTombstones.length) changed = true;
    timeline.snapshotTombstones = tombstones;
    const replayCuts = timeline.replayCuts.filter((item) => item.expiresAtMs > observedAtMs);
    if (replayCuts.length !== timeline.replayCuts.length) changed = true;
    timeline.replayCuts = replayCuts;

    const events = timeline.events.filter((item) => item.committedAtMs >= eventCutoff);
    if (events.length !== timeline.events.length) changed = true;
    timeline.events = events;

    const retainedDedupe = timeline.dedupeRetention.filter((item) => item.committedAtMs >= eventCutoff);
    if (retainedDedupe.length !== timeline.dedupeRetention.length) {
      const retainedKeys = new Set(retainedDedupe.map(dedupeRetentionKey));
      const nextSnapshot = cloneStore(timeline.authority);
      nextSnapshot.dedupe = nextSnapshot.dedupe.filter((item) => retainedKeys.has(canonicalJson([
        item.value.sourceEpoch, item.value.sourceEventId,
      ])));
      const binding = { ...store.owner, scopeId: session.scopeId, sessionId: session.sessionId, timelineEpoch: timeline.timelineEpoch };
      try {
        timeline.authority = snapshotRelayAgentAuthorityState(
          restoreRelayAgentAuthorityState(nextSnapshot, binding),
        );
      } catch {
        throw new RelayAgentAuthorityStoreCorruptError("retention produced an invalid authority projection");
      }
      timeline.dedupeRetention = retainedDedupe;
      changed = true;
    }
  }
  const tombstoneCount = store.sessions.reduce(
    (count, item) => count + (item.timeline?.snapshotTombstones.length ?? 0),
    0,
  );
  if (tombstoneCount > MAX_SNAPSHOT_TOMBSTONES_PER_STORE) {
    throw new RelayAgentAuthorityStoreCapacityError(
      "snapshot_tombstones",
      MAX_SNAPSHOT_TOMBSTONES_PER_STORE,
      tombstoneCount,
    );
  }
  return changed;
}

interface StoreTransactionResult<T> {
  result: T;
  changed: boolean;
}

export class RelayAgentAuthorityStore {
  readonly paths: RelayAgentAuthorityStorePaths;
  readonly owner: Readonly<RelayAgentAuthorityStoreOwner>;

  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomCursor: () => string;
  private readonly renameFile: (source: string, destination: string) => void;
  private readonly fsyncDirectory: (path: string) => void;
  private readonly maximumPersistedBytes: number;
  private readonly persistedJsonBudgets: PersistedJsonBudgets;
  private readonly authorityCapacityOverride: RelayAgentAuthorityCapacityOverride | undefined;
  private readonly configuredRetentionMs: number;
  private readonly continuityAnchor: RelayV2ContinuityAnchor;
  private readonly continuityAnchorId: string;

  private constructor(options: RelayAgentAuthorityStoreOptions) {
    this.owner = Object.freeze(validateOwner({ hostId: options.hostId, hostEpoch: options.hostEpoch }, "store owner"));
    this.continuityAnchorId = relayAgentAuthorityContinuityAnchorId(this.owner);
    if (options.continuityAnchor === null
      || typeof options.continuityAnchor !== "object"
      || options.continuityAnchor.anchorId !== this.continuityAnchorId) {
      throw new RelayAgentAuthorityStoreContinuityUnavailableError(
        "Relay Agent authority continuity anchor is missing or bound to a different owner",
      );
    }
    try {
      this.continuityAnchor = new RelayV2ContinuityAnchor(options.continuityAnchor);
    } catch {
      throw new RelayAgentAuthorityStoreContinuityUnavailableError(
        "Relay Agent authority continuity anchor cannot be constructed",
      );
    }
    this.paths = Object.freeze(options.paths ?? relayAgentAuthorityStorePaths(options.home));
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.randomCursor = options.randomCursor ?? (() => randomBytes(32).toString("base64url"));
    this.renameFile = options.renameFile ?? renameSync;
    this.fsyncDirectory = options.fsyncDirectory ?? fsyncDirectorySync;
    this.maximumPersistedBytes = options.testMaxPersistedBytes ?? RELAY_AGENT_AUTHORITY_STORE_MAX_PERSISTED_BYTES;
    if (!Number.isSafeInteger(this.maximumPersistedBytes)
      || this.maximumPersistedBytes < 1
      || this.maximumPersistedBytes > RELAY_AGENT_AUTHORITY_STORE_MAX_PERSISTED_BYTES) {
      throw new RangeError("testMaxPersistedBytes may only shrink the production store budget");
    }
    const maximumKeys = options.testMaxPersistedJsonKeys ?? MAX_STATE_JSON_KEYS;
    const maximumNodes = options.testMaxPersistedJsonNodes ?? MAX_STATE_JSON_NODES;
    if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1 || maximumKeys > MAX_STATE_JSON_KEYS) {
      throw new RangeError("testMaxPersistedJsonKeys may only shrink the production store budget");
    }
    if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > MAX_STATE_JSON_NODES) {
      throw new RangeError("testMaxPersistedJsonNodes may only shrink the production store budget");
    }
    this.persistedJsonBudgets = Object.freeze({
      maximumBytes: this.maximumPersistedBytes,
      maximumKeys,
      maximumNodes,
    });
    this.configuredRetentionMs = options.eventReplayRetentionMs ?? RELAY_AGENT_DEFAULT_REPLAY_RETENTION_MS;
    if (!Number.isSafeInteger(this.configuredRetentionMs)
      || this.configuredRetentionMs < RELAY_AGENT_MIN_REPLAY_RETENTION_MS) {
      throw new RangeError("eventReplayRetentionMs is below the frozen minimum");
    }
    this.authorityCapacityOverride = options.authorityCapacityOverride;
  }

  static async open(options: RelayAgentAuthorityStoreOptions): Promise<RelayAgentAuthorityStore> {
    const store = new RelayAgentAuthorityStore(options);
    await store.initialize();
    return store;
  }

  private observedNow(previous = 0): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("authority store clock must return a safe timestamp");
    return Math.max(previous, value);
  }

  private atomicWriteJson(path: string, value: unknown, maximumBytes: number): void {
    atomicWritePrivateJson(
      path,
      value,
      this.renameFile,
      maximumBytes,
      this.fsyncDirectory,
    );
  }

  private prepareStoreCommit(candidate: PersistedStore): PreparedStoreCommit {
    const firstBytes = Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8");
    const first = validateStore(
      parseStrictJsonBytes(
        firstBytes,
        this.persistedJsonBudgets,
        "candidate authority state",
        true,
      ),
      this.owner,
    );
    const bytes = Buffer.from(`${JSON.stringify(first)}\n`, "utf8");
    const store = validateStore(
      parseStrictJsonBytes(
        bytes,
        this.persistedJsonBudgets,
        "final candidate authority state",
        true,
      ),
      this.owner,
    );
    return {
      store,
      bytes,
      checkpoint: checkpointForStore(store, bytes, this.continuityAnchorId),
    };
  }

  private atomicWriteStore(prepared: PreparedStoreCommit): void {
    atomicWritePrivateBytes(
      this.paths.state,
      prepared.bytes,
      this.renameFile,
      this.maximumPersistedBytes,
      this.fsyncDirectory,
    );
  }

  private async initialize(): Promise<void> {
    ensurePrivateDirectory(dirname(this.paths.continuity), this.fsyncDirectory);
    ensurePrivateDirectory(dirname(this.paths.state), this.fsyncDirectory);
    await this.withReconciledLocalSnapshot(() => undefined);
  }

  private async reconcileCheckpoint(checkpoint: RelayV2ContinuityCheckpoint): Promise<void> {
    try {
      await this.continuityAnchor.reconcile(checkpoint);
    } catch (error) {
      throw mapContinuityError(error);
    }
  }

  private loadOrCreateLocalLocked(createIfMissing: boolean): LocalStoreCommit {
    const state = inspectJsonFile(
      this.paths.state,
      this.persistedJsonBudgets,
      (value) => validateStore(value, this.owner),
    );
    const continuity = inspectJsonFile(
      this.paths.continuity,
      { maximumBytes: MAX_CONTINUITY_BYTES, maximumKeys: 32, maximumNodes: 64 },
      (value) => validateContinuity(value, this.owner),
    );
    if (state.kind === "invalid" || continuity.kind === "invalid") {
      throw new RelayAgentAuthorityStoreCorruptError();
    }
    if (state.kind === "missing" && continuity.kind === "missing") {
      if (!createIfMissing) {
        throw new RelayAgentAuthorityStoreCorruptError(
          "authority state disappeared during continuity reconciliation",
        );
      }
      const created = freshStore(
        this.owner,
        this.configuredRetentionMs,
        parseContinuityIdentifier(this.randomId(), "generated store commit ID"),
        this.observedNow(),
      );
      const prepared = this.prepareStoreCommit(created);
      let statePublished = false;
      try {
        this.atomicWriteStore(prepared);
        statePublished = true;
        this.atomicWriteJson(this.paths.continuity, continuityFor(prepared.store), MAX_CONTINUITY_BYTES);
      } catch (error) {
        if (statePublished || (error instanceof AtomicPublishError && error.published)) {
          throw new RelayAgentAuthorityStoreCommitUncertainError("initial authority store publication is uncertain");
        }
        throw error;
      }
      return { ...prepared, repairLocalWitness: false };
    }
    if (state.kind === "missing") {
      throw new RelayAgentAuthorityStoreCorruptError("authority state is missing while local continuity remains");
    }
    if (state.value.policy.eventReplayRetentionMs !== this.configuredRetentionMs) {
      throw new RelayAgentAuthorityStoreCorruptError("configured replay retention differs from the durable policy");
    }
    let repairLocalWitness = continuity.kind === "missing";
    if (continuity.kind === "valid") {
      const exactMatch = state.value.commitSeq === continuity.value.commitSeq
        && state.value.commitId === continuity.value.commitId
        && state.value.checksum === continuity.value.stateChecksum;
      const stateOneAhead = BigInt(state.value.commitSeq) === BigInt(continuity.value.commitSeq) + 1n
        && state.value.parentCommitId === continuity.value.commitId;
      if (!exactMatch && !stateOneAhead) {
        throw new RelayAgentAuthorityStoreCorruptError("local continuity is divergent from authority state");
      }
      repairLocalWitness = stateOneAhead;
    }
    return {
      store: state.value,
      bytes: state.bytes,
      checkpoint: checkpointForStore(state.value, state.bytes, this.continuityAnchorId),
      repairLocalWitness,
    };
  }

  private readLocalSnapshot(createIfMissing: boolean): LocalStoreCommit {
    const lock = acquireStoreLock(this.paths.lock, this.now, this.randomId, this.fsyncDirectory);
    try {
      return this.loadOrCreateLocalLocked(createIfMissing);
    } finally {
      releaseStoreLock(lock);
    }
  }

  private useRevalidatedLocalSnapshot<T>(
    expected: LoadedStoreCommit,
    reconciliationFailure: unknown | null,
    consumer: (current: LoadedStoreCommit) => T,
  ): { disposition: "retry" } | { disposition: "used"; value: T } {
    const lock = acquireStoreLock(this.paths.lock, this.now, this.randomId, this.fsyncDirectory);
    try {
      const current = this.loadOrCreateLocalLocked(false);
      if (!sameCheckpoint(current.checkpoint, expected.checkpoint)) {
        return { disposition: "retry" };
      }
      if (reconciliationFailure !== null) throw reconciliationFailure;
      if (current.repairLocalWitness) {
        try {
          this.atomicWriteJson(this.paths.continuity, continuityFor(current.store), MAX_CONTINUITY_BYTES);
        } catch {
          throw new RelayAgentAuthorityStoreCommitUncertainError(
            "local continuity repair could not be published",
          );
        }
      }
      return {
        disposition: "used",
        value: consumer({
          store: current.store,
          bytes: current.bytes,
          checkpoint: current.checkpoint,
        }),
      };
    } finally {
      releaseStoreLock(lock);
    }
  }

  private async withReconciledLocalSnapshot<T>(
    consumer: (current: LoadedStoreCommit) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_RECONCILE_REVALIDATION_ATTEMPTS; attempt += 1) {
      const observed = this.readLocalSnapshot(attempt === 0);
      let reconciliationFailure: unknown | null = null;
      try {
        await this.reconcileCheckpoint(observed.checkpoint);
      } catch (error) {
        reconciliationFailure = error;
      }
      const revalidated = this.useRevalidatedLocalSnapshot(
        observed,
        reconciliationFailure,
        consumer,
      );
      if (revalidated.disposition === "used") return revalidated.value;
    }
    throw new RelayAgentAuthorityStoreContinuityUnavailableError(
      "authority state changed repeatedly during continuity reconciliation",
    );
  }

  private localCompareAndPublish(
    expected: Readonly<RelayV2ContinuityCheckpoint>,
    next: Readonly<RelayV2ContinuityCheckpoint>,
    prepared: PreparedStoreCommit,
    signal: AbortSignal,
  ): RelayV2ContinuityLocalCasResult {
    if (signal.aborted || !sameCheckpoint(prepared.checkpoint, next)) {
      return { outcome: "uncertain" };
    }
    const lock = acquireStoreLock(this.paths.lock, this.now, this.randomId, this.fsyncDirectory);
    try {
      if (signal.aborted) return { outcome: "uncertain" };
      const state = inspectJsonFile(
        this.paths.state,
        this.persistedJsonBudgets,
        (value) => validateStore(value, this.owner),
      );
      if (state.kind !== "valid") return { outcome: "uncertain" };
      const continuity = inspectJsonFile(
        this.paths.continuity,
        { maximumBytes: MAX_CONTINUITY_BYTES, maximumKeys: 32, maximumNodes: 64 },
        (value) => validateContinuity(value, this.owner),
      );
      if (continuity.kind === "invalid") return { outcome: "uncertain" };
      if (continuity.kind === "valid") {
        const exactLocalPair = state.value.commitSeq === continuity.value.commitSeq
          && state.value.commitId === continuity.value.commitId
          && state.value.checksum === continuity.value.stateChecksum;
        const stateOneAhead = BigInt(state.value.commitSeq) === BigInt(continuity.value.commitSeq) + 1n
          && state.value.parentCommitId === continuity.value.commitId;
        if (!exactLocalPair && !stateOneAhead) return { outcome: "uncertain" };
      }
      const current = checkpointForStore(state.value, state.bytes, this.continuityAnchorId);
      if (sameCheckpoint(current, next)) {
        try {
          this.atomicWriteJson(this.paths.continuity, continuityFor(state.value), MAX_CONTINUITY_BYTES);
        } catch {
          return { outcome: "uncertain" };
        }
        return { outcome: "already_same", current };
      }
      if (!sameCheckpoint(current, expected)) {
        return { outcome: "conflict", current };
      }
      let statePublished = false;
      try {
        this.atomicWriteStore(prepared);
        statePublished = true;
        this.atomicWriteJson(this.paths.continuity, continuityFor(prepared.store), MAX_CONTINUITY_BYTES);
      } catch (error) {
        if (statePublished || (error instanceof AtomicPublishError && error.published)) {
          return { outcome: "uncertain" };
        }
        return { outcome: "uncertain" };
      }
      return { outcome: "swapped", current: { ...prepared.checkpoint } };
    } finally {
      releaseStoreLock(lock);
    }
  }

  private async commitExpected(
    previous: LoadedStoreCommit,
    working: PersistedStore,
    observedAtMs: number,
  ): Promise<PersistedStore> {
    const commitId = parseContinuityIdentifier(this.randomId(), "generated store commit ID");
    if (commitId === previous.store.commitId) {
      throw new RelayAgentAuthorityStoreCapacityError("commit_id_collision", 1, 1);
    }
    const candidate = sealStore({
      version: RELAY_AGENT_AUTHORITY_STORE_VERSION,
      owner: { ...this.owner },
      policy: { ...working.policy },
      commitSeq: nextCounter(previous.store.commitSeq),
      commitId,
      parentCommitId: previous.store.commitId,
      lastObservedAtMs: observedAtMs,
      sessions: working.sessions,
    });
    const prepared = this.prepareStoreCommit(candidate);
    try {
      await this.continuityAnchor.advance({
        current: previous.checkpoint,
        next: prepared.checkpoint,
        publishState: (expected, next, signal) => (
          this.localCompareAndPublish(expected, next, prepared, signal)
        ),
      });
    } catch (error) {
      throw mapContinuityError(error);
    }
    return prepared.store;
  }

  private async transaction<T>(
    mutator: (working: PersistedStore, observedAtMs: number) => StoreTransactionResult<T>,
  ): Promise<T> {
    const prepared = await this.withReconciledLocalSnapshot((current) => {
      const observedAtMs = this.observedNow(current.store.lastObservedAtMs);
      const working = cloneStore(current.store);
      const pruned = pruneStore(working, observedAtMs);
      const outcome = mutator(working, observedAtMs);
      return { current, observedAtMs, working, pruned, outcome };
    });
    if (prepared.pruned || prepared.outcome.changed) {
      await this.commitExpected(prepared.current, prepared.working, prepared.observedAtMs);
    }
    return prepared.outcome.result;
  }

  private generatedOpaqueId(label: string): string {
    return parseId(this.randomId(), label);
  }

  private generatedCursor(store: PersistedStore, label: string, reserved: ReadonlySet<string> = new Set()): string {
    const occupied = new Set<string>();
    for (const session of store.sessions) {
      for (const cut of session.timeline?.snapshots ?? []) cut.pageCursors.forEach((item) => occupied.add(item));
      for (const cut of session.timeline?.replayCuts ?? []) cut.pageCursors.forEach((item) => occupied.add(item));
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = parseCursor(this.randomCursor(), label);
      if (!occupied.has(candidate) && !reserved.has(candidate)) return candidate;
    }
    throw new RelayAgentAuthorityStoreCapacityError("opaque_cursor_collision", 16, 16);
  }

  private createTimeline(target: RelayAgentAuthorityTarget, previousTimelineEpoch?: string): PersistedTimeline {
    let timelineEpoch: string | null = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.generatedOpaqueId("generated timeline epoch");
      if (candidate !== previousTimelineEpoch) {
        timelineEpoch = candidate;
        break;
      }
    }
    if (timelineEpoch === null) {
      throw new RelayAgentAuthorityStoreCapacityError("timeline_epoch_collision", 16, 16);
    }
    const authority = createRelayAgentAuthorityState(
      { ...this.owner, ...target, timelineEpoch },
      this.authorityCapacityOverride,
    );
    return {
      timelineEpoch,
      authority: snapshotRelayAgentAuthorityState(authority),
      dedupeRetention: [],
      events: [],
      snapshots: [],
      snapshotTombstones: [],
      replayCuts: [],
    };
  }

  ensureTimeline(targetInput: RelayAgentAuthorityTarget): Promise<RelayAgentAuthorityBinding> {
    const target = validateTarget(targetInput);
    return this.transaction((working) => {
      let session = findSession(working, target);
      let changed = false;
      if (!session) {
        if (working.sessions.length >= MAX_SESSION_COUNT) {
          throw new RelayAgentAuthorityStoreCapacityError("sessions", MAX_SESSION_COUNT, working.sessions.length + 1);
        }
        session = {
          ...target,
          support: "unavailable",
          unavailableReason: "adapter_unavailable",
          timeline: null,
        };
        working.sessions.push(session);
        sortSessions(working);
        changed = true;
      }
      if (session.timeline === null) {
        session.timeline = this.createTimeline(target);
        changed = true;
      }
      return {
        changed,
        result: { ...this.owner, ...target, timelineEpoch: session.timeline.timelineEpoch },
      };
    });
  }

  markUnavailable(
    targetInput: RelayAgentAuthorityTarget,
    reason: Exclude<RelayAgentTimelineUnavailableReason, "store_unavailable">,
  ): Promise<void> {
    const target = validateTarget(targetInput);
    if (!["agent_unsupported", "session_not_agent_managed", "adapter_unavailable"].includes(reason)) {
      throw new TypeError("unavailable reason is not accepted by the extension contract");
    }
    return this.transaction((working) => {
      let session = findSession(working, target);
      if (!session) {
        if (working.sessions.length >= MAX_SESSION_COUNT) {
          throw new RelayAgentAuthorityStoreCapacityError("sessions", MAX_SESSION_COUNT, working.sessions.length + 1);
        }
        session = { ...target, support: "unavailable", unavailableReason: reason, timeline: null };
        working.sessions.push(session);
        sortSessions(working);
        return { result: undefined, changed: true };
      }
      const changed = session.support !== "unavailable" || session.unavailableReason !== reason;
      session.support = "unavailable";
      session.unavailableReason = reason;
      return { result: undefined, changed };
    });
  }

  status(targetInput: RelayAgentAuthorityTarget): Promise<RelayAgentTimelineStatus> {
    const target = validateTarget(targetInput);
    return this.transaction((working) => {
      const session = findSession(working, target);
      if (!session) {
        return { changed: false, result: {
          support: "unavailable", reason: "session_not_agent_managed", liveSource: "absent",
          activeSourceEpoch: null, timelineEpoch: null, currentAgentSeq: null,
          earliestReplaySeq: null, limits: null,
        } };
      }
      if (session.support === "unavailable" || session.timeline === null) {
        return { changed: false, result: {
          support: "unavailable", reason: session.unavailableReason ?? "adapter_unavailable", liveSource: "absent",
          activeSourceEpoch: null, timelineEpoch: null, currentAgentSeq: null,
          earliestReplaySeq: null, limits: null,
        } };
      }
      const timeline = session.timeline;
      return { changed: false, result: {
        support: "available",
        reason: null,
        liveSource: timeline.authority.activeSourceAvailability!,
        activeSourceEpoch: timeline.authority.activeSourceEpoch!,
        timelineEpoch: timeline.timelineEpoch,
        currentAgentSeq: timeline.authority.agentEventSeq,
        earliestReplaySeq: replayFloor(timeline),
        limits: {
          maxTextUtf8Bytes: 65_536,
          maxPageRecords: RELAY_AGENT_MAX_PAGE_RECORDS,
          eventReplayRetentionMs: working.policy.eventReplayRetentionMs,
          snapshotLeaseMs: RELAY_AGENT_DEFAULT_SNAPSHOT_LEASE_MS,
        },
      } };
    });
  }

  ingest(
    trustedAdapterBinding: RelayAgentTrustedAdapterBinding,
    sourceInput: unknown,
  ): Promise<RelayAgentAuthorityReduction> {
    const target = validateTarget({
      scopeId: trustedAdapterBinding.scopeId,
      sessionId: trustedAdapterBinding.sessionId,
    });
    if (trustedAdapterBinding.hostId !== this.owner.hostId
      || trustedAdapterBinding.hostEpoch !== this.owner.hostEpoch) {
      throw new RelayAgentAuthorityStoreOwnershipError("trusted adapter host lineage does not own this store");
    }
    return this.transaction((working, observedAtMs) => {
      let session = findSession(working, target);
      if (!session) {
        if (working.sessions.length >= MAX_SESSION_COUNT) {
          throw new RelayAgentAuthorityStoreCapacityError("sessions", MAX_SESSION_COUNT, working.sessions.length + 1);
        }
        session = {
          ...target,
          support: "unavailable",
          unavailableReason: "adapter_unavailable",
          timeline: this.createTimeline(target),
        };
        working.sessions.push(session);
        sortSessions(working);
      } else if (session.timeline === null) {
        session.timeline = this.createTimeline(target);
      }
      const timeline = session.timeline;
      const binding = { ...this.owner, ...target, timelineEpoch: timeline.timelineEpoch };
      let authority;
      try {
        authority = restoreRelayAgentAuthorityState(timeline.authority, binding);
      } catch {
        throw new RelayAgentAuthorityStoreCorruptError("durable authority snapshot cannot be restored for ingestion");
      }

      const sourceRecord = isRecord(sourceInput) ? sourceInput : null;
      const mutation = sourceRecord && isRecord(sourceRecord.mutation) ? sourceRecord.mutation : null;
      const entryId = mutation && (mutation.mutationType === "entry.redacted" || mutation.mutationType === "entry.deleted")
        && typeof mutation.entryId === "string"
        ? mutation.entryId
        : null;
      const previousEntry = entryId === null ? undefined : authority.entries.get(entryId);
      const reduction = reduceRelayAgentAuthority(authority, sourceInput, trustedAdapterBinding);
      let changed = reduction.state !== authority;
      if (changed) timeline.authority = snapshotRelayAgentAuthorityState(reduction.state);

      if (reduction.disposition === "applied" || reduction.disposition === "redundant_terminal") {
        const sourceEpoch = sourceRecord?.sourceEpoch;
        const sourceEventId = sourceRecord?.sourceEventId;
        if (typeof sourceEpoch !== "string" || typeof sourceEventId !== "string"
          || !getRelayAgentAuthorityDedupeEvidence(reduction.state, sourceEpoch, sourceEventId)) {
          throw new RelayAgentAuthorityStoreCorruptError("accepted source event has no durable dedupe evidence");
        }
        const key = canonicalJson([sourceEpoch, sourceEventId]);
        const retained = timeline.dedupeRetention.find((item) => dedupeRetentionKey(item) === key);
        if (!retained) {
          timeline.dedupeRetention.push({ sourceEpoch, sourceEventId, committedAtMs: observedAtMs });
          timeline.dedupeRetention.sort((left, right) => compareUtf8(dedupeRetentionKey(left), dedupeRetentionKey(right)));
          changed = true;
        }
      }

      if (reduction.publicEvent !== null) {
        if (timeline.events.length >= MAX_PUBLIC_EVENTS_PER_TIMELINE) {
          throw new RelayAgentAuthorityStoreCapacityError(
            "public_events",
            MAX_PUBLIC_EVENTS_PER_TIMELINE,
            timeline.events.length + 1,
          );
        }
        timeline.events.push({ committedAtMs: observedAtMs, event: cloneStore(reduction.publicEvent) });
        changed = true;

        if ((reduction.publicEvent.mutation.mutationType === "entry.redacted"
          || reduction.publicEvent.mutation.mutationType === "entry.deleted") && previousEntry) {
          const tombstoneCount = working.sessions.reduce(
            (count, item) => count + (item.timeline?.snapshotTombstones.length ?? 0),
            0,
          );
          if (tombstoneCount + timeline.snapshots.length > MAX_SNAPSHOT_TOMBSTONES_PER_STORE) {
            throw new RelayAgentAuthorityStoreCapacityError(
              "snapshot_tombstones",
              MAX_SNAPSHOT_TOMBSTONES_PER_STORE,
              tombstoneCount + timeline.snapshots.length,
            );
          }
          // Any durable cut or replay prefix that could still expose the old
          // body is retired in the same transaction that publishes mutation.
          timeline.events = timeline.events.filter((item) => (
            compareCounter(item.event.agentEventSeq, previousEntry.createdAgentSeq) > 0
          ));
          for (const cut of timeline.snapshots) {
            timeline.snapshotTombstones.push({
              principalId: cut.principalId,
              clientInstanceId: cut.clientInstanceId,
              snapshotRequestId: cut.snapshotRequestId,
              snapshotId: cut.snapshotId,
              expiresAtMs: Math.min(MAX_SAFE_INTEGER, observedAtMs + working.policy.eventReplayRetentionMs),
            });
          }
          timeline.snapshots = [];
          timeline.replayCuts = [];
        }
      }

      if (reduction.state.activeSourceEpoch !== null) {
        if (session.support !== "available" || session.unavailableReason !== null) changed = true;
        session.support = "available";
        session.unavailableReason = null;
      }
      return { result: reduction, changed };
    });
  }

  snapshot(request: RelayAgentSnapshotGet): Promise<RelayAgentSnapshotPage> {
    const target = validateTarget(request.target);
    const principalId = parseId(request.principalId, "snapshot principalId");
    const clientInstanceId = parseId(request.clientInstanceId, "snapshot clientInstanceId");
    const snapshotRequestId = parseId(request.snapshotRequestId, "snapshotRequestId");
    if (!Number.isSafeInteger(request.nextPageIndex) || request.nextPageIndex < 0) {
      throw new TypeError("snapshot nextPageIndex is invalid");
    }
    if ((request.snapshotId === null) !== (request.cursor === null)
      || (request.snapshotId === null && request.nextPageIndex !== 0)
      || (request.snapshotId !== null && request.nextPageIndex === 0)) {
      throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");
    }
    const snapshotId = request.snapshotId === null ? null : parseId(request.snapshotId, "snapshotId");
    const cursor = request.cursor === null ? null : parseCursor(request.cursor, "snapshot cursor");

    return this.transaction((working, observedAtMs) => {
      const session = findSession(working, target);
      if (!session || session.support !== "available" || session.timeline === null) {
        throw new RelayAgentTimelineRequestError("AGENT_TIMELINE_UNAVAILABLE");
      }
      const timeline = session.timeline;
      const tombstoned = timeline.snapshotTombstones.some((item) => (
        item.principalId === principalId
        && item.clientInstanceId === clientInstanceId
        && (item.snapshotRequestId === snapshotRequestId || (snapshotId !== null && item.snapshotId === snapshotId))
      ));
      if (tombstoned) throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");

      let cut: PersistedSnapshotCut | undefined;
      let pageIndex = request.nextPageIndex;
      let changed = false;
      if (snapshotId === null) {
        cut = timeline.snapshots.find((item) => (
          item.principalId === principalId
          && item.clientInstanceId === clientInstanceId
          && item.snapshotRequestId === snapshotRequestId
        ));
        if (cut) pageIndex = 0;
      } else {
        cut = timeline.snapshots.find((item) => (
          item.principalId === principalId
          && item.clientInstanceId === clientInstanceId
          && item.snapshotRequestId === snapshotRequestId
          && item.snapshotId === snapshotId
        ));
      }

      if (!cut && snapshotId !== null) throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");
      if (!cut) {
        const storeSnapshotCount = working.sessions.reduce(
          (count, item) => count + (item.timeline?.snapshots.length ?? 0),
          0,
        );
        const principalSnapshotCount = working.sessions.reduce(
          (count, item) => count + (item.timeline?.snapshots.filter((candidate) => candidate.principalId === principalId).length ?? 0),
          0,
        );
        if (storeSnapshotCount >= MAX_SNAPSHOTS_PER_STORE) {
          throw new RelayAgentAuthorityStoreCapacityError("snapshots", MAX_SNAPSHOTS_PER_STORE, storeSnapshotCount + 1);
        }
        if (principalSnapshotCount >= MAX_SNAPSHOTS_PER_PRINCIPAL) {
          throw new RelayAgentAuthorityStoreCapacityError(
            "principal_snapshots",
            MAX_SNAPSHOTS_PER_PRINCIPAL,
            principalSnapshotCount + 1,
          );
        }
        const snapshotCutId = this.generatedOpaqueId("generated snapshot ID");
        const throughAgentSeq = timeline.authority.agentEventSeq;
        const earliestRetainedSeq = replayFloor(timeline);
        const recordPages = freezeSnapshotRecordPages({
          owner: this.owner,
          target,
          timelineEpoch: timeline.timelineEpoch,
          snapshotRequestId,
          snapshotId: snapshotCutId,
          throughAgentSeq,
          earliestRetainedSeq,
        }, materializedRecords(timeline));
        const pageCursors: string[] = [];
        const reservedCursors = new Set<string>();
        for (let index = 1; index < recordPages.length; index += 1) {
          const generated = this.generatedCursor(working, "generated snapshot cursor", reservedCursors);
          pageCursors.push(generated);
          reservedCursors.add(generated);
        }
        cut = {
          principalId,
          clientInstanceId,
          snapshotRequestId,
          snapshotId: snapshotCutId,
          createdAtMs: observedAtMs,
          expiresAtMs: Math.min(MAX_SAFE_INTEGER, observedAtMs + working.policy.snapshotLeaseMs),
          throughAgentSeq,
          earliestRetainedSeq,
          recordPages,
          pageCursors,
        };
        validateSnapshotCutPages(cut, this.owner, target, timeline.timelineEpoch, "new snapshot cut");
        timeline.snapshots.push(cut);
        changed = true;
      }

      if (pageIndex > 0) {
        if (pageIndex > cut.pageCursors.length || cut.pageCursors[pageIndex - 1] !== cursor) {
          throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");
        }
      } else if (cursor !== null) {
        throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");
      }
      if (pageIndex >= cut.recordPages.length) {
        throw new RelayAgentTimelineRequestError("AGENT_SNAPSHOT_EXPIRED");
      }
      const records = cut.recordPages[pageIndex]!;
      const isLast = pageIndex >= cut.pageCursors.length;
      return { changed, result: {
        timelineEpoch: timeline.timelineEpoch,
        snapshotRequestId: cut.snapshotRequestId,
        snapshotId: cut.snapshotId,
        pageIndex,
        isLast,
        nextCursor: isLast ? null : cut.pageCursors[pageIndex]!,
        throughAgentSeq: cut.throughAgentSeq,
        earliestRetainedSeq: cut.earliestRetainedSeq,
        records: cloneStore(records),
      } };
    });
  }

  replay(request: RelayAgentReplayGet): Promise<RelayAgentReplayPage> {
    const target = validateTarget(request.target);
    const principalId = parseId(request.principalId, "replay principalId");
    const clientInstanceId = parseId(request.clientInstanceId, "replay clientInstanceId");
    const timelineEpoch = parseId(request.timelineEpoch, "replay timelineEpoch");
    const afterAgentSeq = parseCounter(request.afterAgentSeq, "replay afterAgentSeq");
    const cursor = request.cursor === null ? null : parseCursor(request.cursor, "replay cursor");
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > RELAY_AGENT_MAX_PAGE_RECORDS) {
      throw new TypeError("replay limit is outside the frozen bound");
    }

    return this.transaction((working, observedAtMs) => {
      const session = findSession(working, target);
      if (!session || session.support !== "available" || session.timeline === null) {
        throw new RelayAgentTimelineRequestError("AGENT_TIMELINE_UNAVAILABLE");
      }
      const timeline = session.timeline;
      if (timeline.timelineEpoch !== timelineEpoch) {
        throw new RelayAgentTimelineRequestError("AGENT_TIMELINE_EPOCH_MISMATCH");
      }
      let cut: PersistedReplayCut | undefined;
      let pageIndex = 0;
      let changed = false;
      if (cursor === null) {
        const floor = replayFloor(timeline);
        if (compareCounter(afterAgentSeq, floor) < 0) {
          throw new RelayAgentTimelineRequestError("AGENT_CURSOR_EXPIRED");
        }
        if (compareCounter(afterAgentSeq, timeline.authority.agentEventSeq) > 0) {
          throw new RelayAgentTimelineRequestError("AGENT_CURSOR_AHEAD");
        }
        cut = timeline.replayCuts.find((item) => (
          item.principalId === principalId
          && item.clientInstanceId === clientInstanceId
          && item.afterAgentSeq === afterAgentSeq
          && item.limit === request.limit
        ));
        if (!cut) {
          const cutCount = working.sessions.reduce(
            (count, item) => count + (item.timeline?.replayCuts.length ?? 0),
            0,
          );
          if (cutCount >= MAX_REPLAY_CUTS_PER_STORE) {
            throw new RelayAgentAuthorityStoreCapacityError("replay_cuts", MAX_REPLAY_CUTS_PER_STORE, cutCount + 1);
          }
          const through = timeline.authority.agentEventSeq;
          const events = timeline.events
            .map((item) => item.event)
            .filter((item) => compareCounter(item.agentEventSeq, afterAgentSeq) > 0
              && compareCounter(item.agentEventSeq, through) <= 0)
            .map(cloneStore);
          const eventPages = freezeReplayEventPages({
            owner: this.owner,
            target,
            timelineEpoch,
            afterAgentSeq,
            replayThroughAgentSeq: through,
          }, events, request.limit);
          const pageCursors: string[] = [];
          const reservedCursors = new Set<string>();
          for (let index = 1; index < eventPages.length; index += 1) {
            const generated = this.generatedCursor(working, "generated replay cursor", reservedCursors);
            pageCursors.push(generated);
            reservedCursors.add(generated);
          }
          cut = {
            principalId,
            clientInstanceId,
            afterAgentSeq,
            limit: request.limit,
            replayThroughAgentSeq: through,
            createdAtMs: observedAtMs,
            expiresAtMs: Math.min(MAX_SAFE_INTEGER, observedAtMs + working.policy.snapshotLeaseMs),
            eventPages,
            pageCursors,
          };
          validateReplayCutPages(cut, this.owner, target, timelineEpoch, "new replay cut");
          timeline.replayCuts.push(cut);
          changed = true;
        }
      } else {
        for (const candidate of timeline.replayCuts) {
          if (candidate.principalId !== principalId
            || candidate.clientInstanceId !== clientInstanceId
            || candidate.afterAgentSeq !== afterAgentSeq
            || candidate.limit !== request.limit) continue;
          const cursorIndex = candidate.pageCursors.indexOf(cursor);
          if (cursorIndex >= 0) {
            cut = candidate;
            pageIndex = cursorIndex + 1;
            break;
          }
        }
        if (!cut) throw new RelayAgentTimelineRequestError("AGENT_CURSOR_EXPIRED");
      }
      if (pageIndex >= cut.eventPages.length) {
        throw new RelayAgentTimelineRequestError("AGENT_CURSOR_EXPIRED");
      }
      const events = cut.eventPages[pageIndex]!.map(toReplayEvent);
      const isLast = pageIndex >= cut.pageCursors.length;
      return { changed, result: {
        timelineEpoch,
        afterAgentSeq: cut.afterAgentSeq,
        replayThroughAgentSeq: cut.replayThroughAgentSeq,
        isLast,
        nextCursor: isLast ? null : cut.pageCursors[pageIndex]!,
        events,
      } };
    });
  }

  deleteTimeline(targetInput: RelayAgentAuthorityTarget): Promise<RelayAgentTimelineReset> {
    const target = validateTarget(targetInput);
    return this.transaction((working) => {
      const session = findSession(working, target);
      if (!session || session.timeline === null) {
        throw new RelayAgentTimelineRequestError("AGENT_TIMELINE_UNAVAILABLE");
      }
      const previousTimelineEpoch = session.timeline.timelineEpoch;
      session.timeline = this.createTimeline(target, previousTimelineEpoch);
      session.support = "unavailable";
      session.unavailableReason = "adapter_unavailable";
      return { changed: true, result: {
        ...this.owner,
        ...target,
        previousTimelineEpoch,
        newTimelineEpoch: session.timeline.timelineEpoch,
        reason: "deleted",
      } };
    });
  }
}
