import { createHash, randomUUID } from "node:crypto";
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
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const RELAY_V2_HOST_STATE_VERSION = 1 as const;

const RELAY_V2_HOST_CONTINUITY_VERSION = 1 as const;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 5_000;
const MAX_COUNTER = 18_446_744_073_709_551_615n;
export const RELAY_V2_HOST_STATE_MAX_PERSISTED_BYTES = 512 * 1024 * 1024;
const MATERIALIZED_READINESS_FENCE_RESERVE_BYTES = 1_024;
const MAX_CONTINUITY_BYTES = 16 * 1024;

export type RelayV2MaterializedReadinessFenceReason =
  | "persisted_capacity_exceeded"
  | "reconcile_generation_conflict"
  | "materialized_authority_conflict";

export interface RelayV2MaterializedReadinessFence {
  hostEpoch: string;
  reason: RelayV2MaterializedReadinessFenceReason;
}

export type RelayV2HostJson =
  | null
  | boolean
  | number
  | string
  | RelayV2HostJson[]
  | { [key: string]: RelayV2HostJson };

export interface RelayV2HostStatePaths {
  state: string;
  continuity: string;
  lock: string;
}

export interface RelayV2HostStateSnapshot {
  hostEpoch: string;
  hostInstanceId: string;
  commitSeq: string;
  eventSeq: string;
  revisions: Record<string, string>;
  commands: Record<string, RelayV2HostJson>;
  materialized: Record<string, RelayV2HostJson>;
  materializedReadinessFence: RelayV2MaterializedReadinessFence | null;
}

export interface RelayV2HostStateCommit<T> {
  value: T;
  snapshot: RelayV2HostStateSnapshot;
}

export interface RelayV2HostStateTransaction {
  readonly hostEpoch: string;
  getCommandRecord(key: string): RelayV2HostJson | undefined;
  putCommandRecord(key: string, value: RelayV2HostJson): void;
  deleteCommandRecord(key: string): void;
  getMaterializedRecord(key: string): RelayV2HostJson | undefined;
  putMaterializedRecord(key: string, value: RelayV2HostJson): void;
  deleteMaterializedRecord(key: string): void;
  getRevision(revisionKey: string): string | undefined;
  allocateRevision(revisionKey: string): string;
  allocateEventSeq(): string;
  issueOpaqueId(prefix?: string): string;
  getMaterializedReadinessFence(): RelayV2MaterializedReadinessFence | null;
  latchMaterializedReadinessFence(reason: RelayV2MaterializedReadinessFenceReason): void;
  clearMaterializedReadinessFence(): void;
}

export interface RelayV2HostStateCriticalSection {
  read(): RelayV2HostStateSnapshot;
  transaction<T>(
    mutation: (transaction: RelayV2HostStateTransaction) => T,
  ): RelayV2HostStateCommit<T>;
  latchMaterializedReadinessFence(
    reason: RelayV2MaterializedReadinessFenceReason,
  ): RelayV2HostStateCommit<void>;
}

export interface RelayV2HostStateStoreOptions {
  home?: string;
  paths?: RelayV2HostStatePaths;
  renameFile?: (source: string, destination: string) => void;
  /** Tests may only shrink the frozen exact serialized state-file budget. */
  testMaxPersistedBytes?: number;
}

interface PersistedHostStateUnsigned {
  // Deliberately only business authority records. Host access/refresh
  // credentials belong to a separate credential store and never enter this
  // transaction schema or its continuity witness.
  version: typeof RELAY_V2_HOST_STATE_VERSION;
  hostEpoch: string;
  commitSeq: string;
  commitId: string;
  parentCommitId: string | null;
  eventSeq: string;
  revisions: Record<string, string>;
  commands: Record<string, RelayV2HostJson>;
  materialized: Record<string, RelayV2HostJson>;
  materializedReadinessFence: RelayV2MaterializedReadinessFence | null;
}

interface PersistedHostState extends PersistedHostStateUnsigned {
  checksum: string;
}

interface ContinuityWitness {
  version: typeof RELAY_V2_HOST_CONTINUITY_VERSION;
  hostEpoch: string;
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
  createdAt: number;
}

type FileInspection<T> =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: T };

class AtomicPublishError extends Error {
  readonly published: boolean;
  readonly original: unknown;

  constructor(path: string, published: boolean, original: unknown) {
    super(`failed to publish Relay v2 host state file ${path}`);
    this.name = "AtomicPublishError";
    this.published = published;
    this.original = original;
  }
}

export class RelayV2HostStateCommitUncertainError extends Error {
  readonly code = "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN";

  constructor(message: string) {
    super(message);
    this.name = "RelayV2HostStateCommitUncertainError";
  }
}

export class RelayV2HostStateCapacityError extends Error {
  readonly code = "RELAY_V2_HOST_STATE_CAPACITY_EXCEEDED";

  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
  ) {
    super("Relay v2 persisted host state exceeds its frozen serialized budget");
    this.name = "RelayV2HostStateCapacityError";
  }
}

export function relayV2HostStatePaths(home = homedir()): RelayV2HostStatePaths {
  const twHome = join(home, ".tmux-worktree");
  const stateRoot = join(twHome, "relay-v2-host-state");
  return {
    state: join(stateRoot, "state-v1.json"),
    // Keep the witness outside the database directory so restoring or replacing
    // only the database cannot silently restore an older host lineage.
    continuity: join(twHome, "relay-v2-host-continuity-v1.json"),
    lock: join(stateRoot, "state-v1.lock"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const expected = new Set(required);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCanonicalCounter(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_COUNTER;
  } catch {
    return false;
  }
}

function parseMaterializedReadinessFence(
  value: unknown,
  hostEpoch: string,
): RelayV2MaterializedReadinessFence | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["hostEpoch", "reason"])) {
    throw new Error("Relay v2 materialized readiness fence is malformed");
  }
  if (value.hostEpoch !== hostEpoch
    || (value.reason !== "persisted_capacity_exceeded"
      && value.reason !== "reconcile_generation_conflict"
      && value.reason !== "materialized_authority_conflict")) {
    throw new Error("Relay v2 materialized readiness fence crossed host lineage");
  }
  return {
    hostEpoch,
    reason: value.reason,
  };
}

function nextCounter(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > MAX_COUNTER) throw new Error("Relay v2 host state counter exhausted");
  return next.toString(10);
}

function validateStoreKey(value: string, label: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 256
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error(`invalid Relay v2 host state ${label}`);
  }
}

function validateJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): asserts value is RelayV2HostJson {
  if (depth > 64) throw new Error("Relay v2 host state record is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Relay v2 host state record contains a non-finite number");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Relay v2 host state records must contain only JSON values");
  }
  if (seen.has(value)) throw new Error("Relay v2 host state record contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, seen, depth + 1);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Relay v2 host state records must use plain JSON objects");
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("\0")) throw new Error("Relay v2 host state record contains an invalid object key");
      validateJson(item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function cloneJson<T extends RelayV2HostJson>(value: T): T {
  validateJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function copyRecordMap(
  value: Record<string, RelayV2HostJson>,
): Record<string, RelayV2HostJson> {
  const copy = Object.create(null) as Record<string, RelayV2HostJson>;
  for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
  return copy;
}

function copyStringMap(value: Record<string, string>): Record<string, string> {
  const copy = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) copy[key] = item;
  return copy;
}

function isJsonRecordMap(value: unknown): value is Record<string, RelayV2HostJson> {
  if (!isRecord(value)) return false;
  try {
    for (const [key, item] of Object.entries(value)) {
      validateStoreKey(key, "record key");
      validateJson(item);
    }
    return true;
  } catch {
    return false;
  }
}

function isRevisionMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  try {
    for (const [key, revision] of Object.entries(value)) {
      validateStoreKey(key, "revision key");
      if (!isCanonicalCounter(revision)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalJson(value: RelayV2HostJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot checksum a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`
  )).join(",")}}`;
}

function stateChecksum(state: PersistedHostStateUnsigned): string {
  return createHash("sha256")
    .update(canonicalJson(state as unknown as RelayV2HostJson), "utf8")
    .digest("hex");
}

function sealState(state: PersistedHostStateUnsigned): PersistedHostState {
  return { ...state, checksum: stateChecksum(state) };
}

function parseHostState(value: unknown): PersistedHostState {
  const legacyKeys = [
    "version",
    "hostEpoch",
    "commitSeq",
    "commitId",
    "parentCommitId",
    "eventSeq",
    "revisions",
    "commands",
    "materialized",
    "checksum",
  ] as const;
  const keys = [...legacyKeys.slice(0, -1), "materializedReadinessFence", "checksum"] as const;
  if (!isRecord(value)
    || (!hasExactKeys(value, keys) && !hasExactKeys(value, legacyKeys))) {
    throw new Error("Relay v2 host state root is malformed");
  }
  if (value.version !== RELAY_V2_HOST_STATE_VERSION) {
    throw new Error("Relay v2 host state version is unsupported");
  }
  if (!isUuid(value.hostEpoch) || !isUuid(value.commitId)) {
    throw new Error("Relay v2 host state lineage is malformed");
  }
  if (!isCanonicalCounter(value.commitSeq) || !isCanonicalCounter(value.eventSeq)) {
    throw new Error("Relay v2 host state counter is malformed");
  }
  if (
    (value.commitSeq === "0" && value.parentCommitId !== null)
    || (value.commitSeq !== "0" && !isUuid(value.parentCommitId))
  ) {
    throw new Error("Relay v2 host state parent commit is malformed");
  }
  if (!isRevisionMap(value.revisions)
    || !isJsonRecordMap(value.commands)
    || !isJsonRecordMap(value.materialized)) {
    throw new Error("Relay v2 host state records are malformed");
  }
  if (typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum)) {
    throw new Error("Relay v2 host state checksum is malformed");
  }
  const base = {
    version: RELAY_V2_HOST_STATE_VERSION,
    hostEpoch: value.hostEpoch,
    commitSeq: value.commitSeq,
    commitId: value.commitId,
    parentCommitId: value.parentCommitId as string | null,
    eventSeq: value.eventSeq,
    revisions: value.revisions,
    commands: value.commands,
    materialized: value.materialized,
  };
  const hasFence = Object.hasOwn(value, "materializedReadinessFence");
  const checksummed = hasFence
    ? {
        ...base,
        materializedReadinessFence: parseMaterializedReadinessFence(
          value.materializedReadinessFence,
          value.hostEpoch,
        ),
      }
    : base;
  if (stateChecksum(checksummed as PersistedHostStateUnsigned) !== value.checksum) {
    throw new Error("Relay v2 host state checksum does not match");
  }
  return {
    ...base,
    materializedReadinessFence: hasFence
      ? parseMaterializedReadinessFence(value.materializedReadinessFence, value.hostEpoch)
      : null,
    checksum: value.checksum,
  };
}

function parseContinuityWitness(value: unknown): ContinuityWitness {
  const keys = ["version", "hostEpoch", "commitSeq", "commitId", "stateChecksum"] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error("Relay v2 host continuity witness is malformed");
  }
  if (value.version !== RELAY_V2_HOST_CONTINUITY_VERSION
    || !isUuid(value.hostEpoch)
    || !isCanonicalCounter(value.commitSeq)
    || !isUuid(value.commitId)
    || typeof value.stateChecksum !== "string"
    || !/^[0-9a-f]{64}$/.test(value.stateChecksum)) {
    throw new Error("Relay v2 host continuity witness fields are malformed");
  }
  return value as unknown as ContinuityWitness;
}

function witnessFor(state: PersistedHostState): ContinuityWitness {
  return {
    version: RELAY_V2_HOST_CONTINUITY_VERSION,
    hostEpoch: state.hostEpoch,
    commitSeq: state.commitSeq,
    commitId: state.commitId,
    stateChecksum: state.checksum,
  };
}

function witnessMatchesState(witness: ContinuityWitness, state: PersistedHostState): boolean {
  return witness.hostEpoch === state.hostEpoch
    && witness.commitSeq === state.commitSeq
    && witness.commitId === state.commitId
    && witness.stateChecksum === state.checksum;
}

function stateImmediatelyFollowsWitness(
  state: PersistedHostState,
  witness: ContinuityWitness,
): boolean {
  return state.hostEpoch === witness.hostEpoch
    && state.commitSeq === nextCounter(witness.commitSeq)
    && state.parentCommitId === witness.commitId;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  const uid = process.getuid?.();
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error(`Relay v2 host state directory is not a private real directory: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function inspectJsonFile<T>(
  path: string,
  maxBytes: number,
  parse: (value: unknown) => T,
): FileInspection<T> {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  const uid = process.getuid?.();
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || (uid !== undefined && metadata.uid !== uid)) {
    throw new Error(`Relay v2 host state file is not a private owned regular file: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) chmodSync(path, 0o600);
  if (metadata.size > maxBytes) return { kind: "invalid" };
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    return { kind: "valid", value: parse(JSON.parse(contents)) };
  } catch {
    return { kind: "invalid" };
  }
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

function atomicWriteJson(
  path: string,
  value: unknown,
  renameFile: (source: string, destination: string) => void,
  maxBytes?: number,
): void {
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (maxBytes !== undefined && contents.byteLength > maxBytes) {
    throw new RelayV2HostStateCapacityError(contents.byteLength, maxBytes);
  }
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = -1;
  let published = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
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
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    renameFile(temporary, path);
    published = true;
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    throw new AtomicPublishError(path, published, error);
  } finally {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

function lockOwnerPath(path: string): string {
  return join(path, LOCK_OWNER_FILE);
}

function readLockOwner(path: string): StoreLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(path), "utf8")) as unknown;
    if (!isRecord(value) || !hasExactKeys(value, ["owner", "pid", "createdAt"])) return undefined;
    if (typeof value.owner !== "string"
      || !Number.isSafeInteger(value.pid)
      || typeof value.createdAt !== "number"
      || !Number.isFinite(value.createdAt)) return undefined;
    return value as unknown as StoreLockOwner;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(path: string): boolean {
  const owner = readLockOwner(path);
  if (owner) return Date.now() - owner.createdAt > LOCK_STALE_MS && !processExists(owner.pid);
  try {
    return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function discardStaleLock(path: string): void {
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!lockIsStale(quarantine)) {
    try {
      renameSync(quarantine, path);
    } catch {
      throw new Error("Relay v2 host state lock changed during stale-lock recovery");
    }
    return;
  }
  rmSync(quarantine, { recursive: true, force: true });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireStoreLock(path: string): Promise<StoreLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const owner = `${process.pid}-${randomUUID()}`;
  ensurePrivateDirectory(dirname(path));
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try {
        writeFileSync(lockOwnerPath(path), `${JSON.stringify({
          owner,
          pid: process.pid,
          createdAt: Date.now(),
        } satisfies StoreLockOwner)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
      return { path, owner };
    } catch (error) {
      if (!existsSync(path)) throw error;
      if (lockIsStale(path)) {
        discardStaleLock(path);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for Relay v2 host state lock: ${path}`);
      }
      await delay(20);
    }
  }
}

function releaseStoreLock(lock: StoreLock): void {
  if (readLockOwner(lock.path)?.owner !== lock.owner) return;
  rmSync(lock.path, { recursive: true, force: true });
}

function freshState(previousEpochs: Iterable<string> = []): PersistedHostState {
  const excluded = new Set(previousEpochs);
  let hostEpoch = randomUUID();
  while (excluded.has(hostEpoch)) hostEpoch = randomUUID();
  return sealState({
    version: RELAY_V2_HOST_STATE_VERSION,
    hostEpoch,
    commitSeq: "0",
    commitId: randomUUID(),
    parentCommitId: null,
    eventSeq: "0",
    revisions: Object.create(null) as Record<string, string>,
    commands: Object.create(null) as Record<string, RelayV2HostJson>,
    materialized: Object.create(null) as Record<string, RelayV2HostJson>,
    materializedReadinessFence: null,
  });
}

function snapshotFrom(
  state: PersistedHostState,
  hostInstanceId: string,
): RelayV2HostStateSnapshot {
  return {
    hostEpoch: state.hostEpoch,
    hostInstanceId,
    commitSeq: state.commitSeq,
    eventSeq: state.eventSeq,
    revisions: copyStringMap(state.revisions),
    commands: copyRecordMap(state.commands),
    materialized: copyRecordMap(state.materialized),
    materializedReadinessFence: state.materializedReadinessFence === null
      ? null
      : { ...state.materializedReadinessFence },
  };
}

class HostStateTransaction implements RelayV2HostStateTransaction {
  readonly draft: PersistedHostStateUnsigned;

  constructor(current: PersistedHostState) {
    this.draft = {
      version: RELAY_V2_HOST_STATE_VERSION,
      hostEpoch: current.hostEpoch,
      commitSeq: current.commitSeq,
      commitId: current.commitId,
      parentCommitId: current.parentCommitId,
      eventSeq: current.eventSeq,
      revisions: copyStringMap(current.revisions),
      commands: copyRecordMap(current.commands),
      materialized: copyRecordMap(current.materialized),
      materializedReadinessFence: current.materializedReadinessFence === null
        ? null
        : { ...current.materializedReadinessFence },
    };
  }

  get hostEpoch(): string {
    return this.draft.hostEpoch;
  }

  getCommandRecord(key: string): RelayV2HostJson | undefined {
    validateStoreKey(key, "command key");
    const value = this.draft.commands[key];
    return value === undefined ? undefined : cloneJson(value);
  }

  putCommandRecord(key: string, value: RelayV2HostJson): void {
    validateStoreKey(key, "command key");
    this.draft.commands[key] = cloneJson(value);
  }

  deleteCommandRecord(key: string): void {
    validateStoreKey(key, "command key");
    delete this.draft.commands[key];
  }

  getMaterializedRecord(key: string): RelayV2HostJson | undefined {
    validateStoreKey(key, "materialized key");
    const value = this.draft.materialized[key];
    return value === undefined ? undefined : cloneJson(value);
  }

  putMaterializedRecord(key: string, value: RelayV2HostJson): void {
    validateStoreKey(key, "materialized key");
    this.draft.materialized[key] = cloneJson(value);
  }

  deleteMaterializedRecord(key: string): void {
    validateStoreKey(key, "materialized key");
    delete this.draft.materialized[key];
  }

  getRevision(revisionKey: string): string | undefined {
    validateStoreKey(revisionKey, "revision key");
    return this.draft.revisions[revisionKey];
  }

  allocateRevision(revisionKey: string): string {
    validateStoreKey(revisionKey, "revision key");
    const next = nextCounter(this.draft.revisions[revisionKey] ?? "0");
    this.draft.revisions[revisionKey] = next;
    return next;
  }

  allocateEventSeq(): string {
    this.draft.eventSeq = nextCounter(this.draft.eventSeq);
    return this.draft.eventSeq;
  }

  issueOpaqueId(prefix = "id"): string {
    if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) {
      throw new Error("invalid Relay v2 opaque ID prefix");
    }
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }

  clearMaterializedReadinessFence(): void {
    this.draft.materializedReadinessFence = null;
  }

  getMaterializedReadinessFence(): RelayV2MaterializedReadinessFence | null {
    return this.draft.materializedReadinessFence === null
      ? null
      : { ...this.draft.materializedReadinessFence };
  }

  latchMaterializedReadinessFence(reason: RelayV2MaterializedReadinessFenceReason): void {
    this.draft.materializedReadinessFence = {
      hostEpoch: this.draft.hostEpoch,
      reason,
    };
  }
}

class HostStateCriticalSection implements RelayV2HostStateCriticalSection {
  private current: PersistedHostState;

  constructor(
    current: PersistedHostState,
    private readonly hostInstanceId: string,
    private readonly publish: (state: PersistedHostState, emergencyFence: boolean) => void,
  ) {
    this.current = current;
  }

  read(): RelayV2HostStateSnapshot {
    return snapshotFrom(this.current, this.hostInstanceId);
  }

  transaction<T>(
    mutation: (transaction: RelayV2HostStateTransaction) => T,
  ): RelayV2HostStateCommit<T> {
    const transaction = new HostStateTransaction(this.current);
    const value = mutation(transaction);
    if (value && typeof (value as { then?: unknown }).then === "function") {
      throw new Error("Relay v2 host state transaction callbacks must be synchronous");
    }
    return this.commit(transaction, value, false);
  }

  latchMaterializedReadinessFence(
    reason: RelayV2MaterializedReadinessFenceReason,
  ): RelayV2HostStateCommit<void> {
    if (this.current.materializedReadinessFence?.reason === reason) {
      return { value: undefined, snapshot: this.read() };
    }
    const transaction = new HostStateTransaction(this.current);
    transaction.latchMaterializedReadinessFence(reason);
    return this.commit(transaction, undefined, true);
  }

  private commit<T>(
    transaction: HostStateTransaction,
    value: T,
    emergencyFence: boolean,
  ): RelayV2HostStateCommit<T> {
    const next = sealState({
      ...transaction.draft,
      commitSeq: nextCounter(this.current.commitSeq),
      commitId: randomUUID(),
      parentCommitId: this.current.commitId,
    });
    try {
      this.publish(next, emergencyFence);
      this.current = next;
    } catch (error) {
      if (error instanceof RelayV2HostStateCommitUncertainError) this.current = next;
      throw error;
    }
    return { value, snapshot: this.read() };
  }
}

export class RelayV2HostStateStore {
  readonly paths: RelayV2HostStatePaths;
  readonly hostInstanceId: string;

  private readonly renameFile: (source: string, destination: string) => void;
  private readonly maxPersistedBytes: number;
  private serializerTail: Promise<void> = Promise.resolve();

  private constructor(options: RelayV2HostStateStoreOptions) {
    this.paths = options.paths ?? relayV2HostStatePaths(options.home);
    this.renameFile = options.renameFile ?? renameSync;
    this.maxPersistedBytes = options.testMaxPersistedBytes
      ?? RELAY_V2_HOST_STATE_MAX_PERSISTED_BYTES;
    if (!Number.isSafeInteger(this.maxPersistedBytes)
      || this.maxPersistedBytes <= MATERIALIZED_READINESS_FENCE_RESERVE_BYTES
      || this.maxPersistedBytes > RELAY_V2_HOST_STATE_MAX_PERSISTED_BYTES) {
      throw new Error("invalid Relay v2 persisted host state byte budget");
    }
    // One store instance represents one relay-host process lifetime. This ID is
    // intentionally absent from every persisted schema.
    this.hostInstanceId = randomUUID();
  }

  static async open(
    options: RelayV2HostStateStoreOptions = {},
  ): Promise<RelayV2HostStateStore> {
    const store = new RelayV2HostStateStore(options);
    await store.serialize(() => undefined);
    return store;
  }

  async read(): Promise<RelayV2HostStateSnapshot> {
    return this.serialize((section) => section.read());
  }

  async transaction<T>(
    mutation: (transaction: RelayV2HostStateTransaction) => T,
  ): Promise<RelayV2HostStateCommit<T>> {
    return this.serialize((section) => section.transaction(mutation));
  }

  /**
   * Run a short host state/event critical section.
   *
   * H2 can commit or capture eventSeq, register its W+1 subscriber, and enqueue
   * the welcome barrier before this method releases the serializer. Callers
   * must not perform backend/network I/O while holding this section.
   */
  async serialize<T>(
    operation: (section: RelayV2HostStateCriticalSection) => T | Promise<T>,
  ): Promise<T> {
    let releaseTurn!: () => void;
    const previous = this.serializerTail;
    this.serializerTail = new Promise<void>((resolve) => { releaseTurn = resolve; });
    await previous;

    let lock: StoreLock | undefined;
    try {
      lock = await acquireStoreLock(this.paths.lock);
      const state = this.loadOrCreateState();
      const section = new HostStateCriticalSection(
        state,
        this.hostInstanceId,
        (next, emergencyFence) => this.publishState(next, emergencyFence),
      );
      return await operation(section);
    } finally {
      if (lock) releaseStoreLock(lock);
      releaseTurn();
    }
  }

  private loadOrCreateState(): PersistedHostState {
    ensurePrivateDirectory(dirname(this.paths.state));
    ensurePrivateDirectory(dirname(this.paths.continuity));
    const state = inspectJsonFile(this.paths.state, this.maxPersistedBytes, parseHostState);
    const witness = inspectJsonFile(
      this.paths.continuity,
      MAX_CONTINUITY_BYTES,
      parseContinuityWitness,
    );

    if (state.kind === "valid" && witness.kind === "valid") {
      if (witnessMatchesState(witness.value, state.value)) return state.value;
      if (stateImmediatelyFollowsWitness(state.value, witness.value)) {
        // state-v1.json is the commit point. A crash or lost ACK after that
        // rename can leave the witness one commit behind; repairing it exposes
        // the already complete transaction, never a partial record set.
        atomicWriteJson(
          this.paths.continuity,
          witnessFor(state.value),
          this.renameFile,
        );
        return state.value;
      }
    }

    const previousEpochs: string[] = [];
    if (state.kind === "valid") previousEpochs.push(state.value.hostEpoch);
    if (witness.kind === "valid") previousEpochs.push(witness.value.hostEpoch);
    const replacement = freshState(previousEpochs);
    // Missing/corrupt/mismatched files are a lineage break. Publish a wholly
    // new empty authority before its witness; no old cursor or command record
    // can become authoritative in the replacement epoch.
    atomicWriteJson(
      this.paths.state,
      replacement,
      this.renameFile,
      this.maxPersistedBytes,
    );
    atomicWriteJson(this.paths.continuity, witnessFor(replacement), this.renameFile);
    return replacement;
  }

  private publishState(state: PersistedHostState, emergencyFence: boolean): void {
    try {
      atomicWriteJson(
        this.paths.state,
        state,
        this.renameFile,
        emergencyFence
          ? this.maxPersistedBytes
          : this.maxPersistedBytes - MATERIALIZED_READINESS_FENCE_RESERVE_BYTES,
      );
    } catch (error) {
      if (error instanceof AtomicPublishError && error.published) {
        throw new RelayV2HostStateCommitUncertainError(
          "Relay v2 host state transaction reached its atomic commit point but durability confirmation failed",
        );
      }
      if (error instanceof AtomicPublishError) throw error.original;
      throw error;
    }

    try {
      atomicWriteJson(this.paths.continuity, witnessFor(state), this.renameFile);
    } catch {
      throw new RelayV2HostStateCommitUncertainError(
        "Relay v2 host state transaction committed, but continuity witness publication must be repaired",
      );
    }
  }
}
