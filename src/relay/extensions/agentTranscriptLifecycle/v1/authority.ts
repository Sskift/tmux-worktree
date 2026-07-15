import { createHash } from "node:crypto";

const UINT64_MAX = 18_446_744_073_709_551_615n;
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_ID_UTF8_BYTES = 128;
const MAX_TEXT_UTF8_BYTES = 65_536;
const MAX_FAILURE_SUMMARY_UTF8_BYTES = 1_024;
const VERIFIED_STATES = new WeakSet<object>();

export const RELAY_AGENT_AUTHORITY_HARD_LIMITS = Object.freeze({
  maxSourceCount: 1_024,
  maxSourceCanonicalBytes: 1_048_576,
  maxDedupeEvidenceCount: 100_000,
  maxDedupeCanonicalBytes: 33_554_432,
  maxRunCount: 50_000,
  maxRunCanonicalBytes: 16_777_216,
  maxTurnCount: 100_000,
  maxTurnCanonicalBytes: 33_554_432,
  maxEntryCount: 50_000,
  maxEntryCanonicalBytes: 50_331_648,
  maxTombstoneCount: 100_000,
  maxTombstoneCanonicalBytes: 16_777_216,
  maxActiveTurnIndexCount: 50_000,
  maxActiveTurnIndexCanonicalBytes: 8_388_608,
  maxCanonicalBytes: 67_108_864,
});

export type RelayAgentLifecycleState =
  | "running"
  | "waiting_for_user"
  | "failed"
  | "completed";

export type RelayAgentSourceAvailability = "connected" | "interrupted";

export type RelayAgentAuthorityDisposition =
  | "applied"
  | "duplicate"
  | "source_gap"
  | "stale_source"
  | "source_event_conflict"
  | "source_history_expired"
  | "invalid_transition"
  | "redundant_terminal"
  | "terminal_conflict"
  | "entry_id_conflict"
  | "entry_deleted";

export type RelayAgentEntryRole = "user" | "agent";
export type RelayAgentEntryRedactionReason = "user_request" | "policy" | "retention";

export interface RelayAgentAuthorityBinding {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  timelineEpoch: string;
}

/** Authenticated adapter route binding; timelineEpoch remains store-owned. */
export interface RelayAgentTrustedAdapterBinding {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
}

export type RelayAgentAuthorityLimits = Readonly<typeof RELAY_AGENT_AUTHORITY_HARD_LIMITS>;
export type RelayAgentAuthorityCapacityOverride = Partial<RelayAgentAuthorityLimits>;

export interface RelayAgentFailure {
  code: string;
  summary: string | null;
}

export interface RelayAgentSourceStartedMutation {
  mutationType: "source.started";
}

export interface RelayAgentSourceAvailabilityMutation {
  mutationType: "source.availability";
  state: RelayAgentSourceAvailability;
  reason: "source_disconnected" | "source_restarted";
}

export interface RelayAgentLifecycleChangedMutation {
  mutationType: "lifecycle.changed";
  scope: "run" | "turn";
  runId: string;
  turnId: string | null;
  state: RelayAgentLifecycleState;
  failure: RelayAgentFailure | null;
}

export interface RelayAgentTextEntryAppendedMutation {
  mutationType: "text_entry.appended";
  entryId: string;
  runId: string;
  turnId: string;
  role: RelayAgentEntryRole;
  text: string;
  commandId: string | null;
}

export interface RelayAgentEntryRedactedMutation {
  mutationType: "entry.redacted";
  entryId: string;
  reason: RelayAgentEntryRedactionReason;
}

export interface RelayAgentEntryDeletedMutation {
  mutationType: "entry.deleted";
  entryId: string;
  reason: RelayAgentEntryRedactionReason;
}

export type RelayAgentSourceMutation =
  | RelayAgentSourceStartedMutation
  | RelayAgentSourceAvailabilityMutation
  | RelayAgentLifecycleChangedMutation
  | RelayAgentTextEntryAppendedMutation
  | RelayAgentEntryRedactedMutation
  | RelayAgentEntryDeletedMutation;

export interface RelayAgentSourceEvent {
  sourceEpoch: string;
  sourceSeq: string;
  sourceEventId: string;
  occurredAtMs: number;
  mutation: RelayAgentSourceMutation;
}

export interface RelayAgentLifecycleRecord {
  recordType: "lifecycle";
  lifecycleEventId: string;
  sourceEpoch: string;
  scope: "run" | "turn";
  runId: string;
  turnId: string | null;
  state: RelayAgentLifecycleState;
  failure: RelayAgentFailure | null;
  occurredAtMs: number;
  agentEventSeq: string;
}

export interface RelayAgentTextEntryRecord {
  recordType: "text_entry";
  entryId: string;
  runId: string;
  turnId: string;
  role: RelayAgentEntryRole;
  state: "visible" | "redacted";
  text: string | null;
  redactionReason: RelayAgentEntryRedactionReason | null;
  commandId: string | null;
  createdAtMs: number;
  createdAgentSeq: string;
  lastModifiedAgentSeq: string;
}

export interface RelayAgentRunRecord {
  runId: string;
  sourceEpoch: string;
  state: RelayAgentLifecycleState;
  turnCount: number;
  lifecycle: RelayAgentLifecycleRecord;
}

export interface RelayAgentTurnRecord {
  turnId: string;
  runId: string;
  sourceEpoch: string;
  state: RelayAgentLifecycleState;
  lifecycle: RelayAgentLifecycleRecord;
}

export interface RelayAgentActiveTurnIndexRecord {
  runId: string;
  turnId: string;
  sourceEpoch: string;
}

export interface RelayAgentDeletedEntryTombstone {
  entryId: string;
  sourceEpoch: string;
  reason: RelayAgentEntryRedactionReason;
  deletedAgentSeq: string;
}

export interface RelayAgentSourceDedupeEvidence {
  sessionId: string;
  timelineEpoch: string;
  sourceEpoch: string;
  sourceEventId: string;
  sourceSeq: string;
  fingerprintAlgorithm: "sha256-canonical-json";
  fingerprintDigest: string;
}

export interface RelayAgentSourceAuthorityState {
  sourceEpoch: string;
  lastSourceSeq: string;
  fenced: boolean;
  availability: RelayAgentSourceAvailability;
  availabilityEventId: string;
  availabilityAgentEventSeq: string;
  availabilityOccurredAtMs: number;
}

export interface RelayAgentAuthorityUsage {
  sourceCount: number;
  sourceCanonicalBytes: number;
  dedupeEvidenceCount: number;
  dedupeCanonicalBytes: number;
  runCount: number;
  runCanonicalBytes: number;
  turnCount: number;
  turnCanonicalBytes: number;
  entryCount: number;
  entryCanonicalBytes: number;
  tombstoneCount: number;
  tombstoneCanonicalBytes: number;
  activeTurnIndexCount: number;
  activeTurnIndexCanonicalBytes: number;
  totalCanonicalBytes: number;
}

export interface RelayAgentAuthorityIndex<V> {
  readonly size: number;
  get(key: string): V | undefined;
  entries(): IterableIterator<readonly [string, V]>;
  values(): IterableIterator<V>;
}

export interface RelayAgentAuthorityState {
  readonly schemaVersion: 1;
  readonly binding: Readonly<RelayAgentAuthorityBinding>;
  readonly limits: RelayAgentAuthorityLimits;
  readonly usage: Readonly<RelayAgentAuthorityUsage>;
  readonly agentEventSeq: string;
  readonly activeSourceEpoch: string | null;
  readonly activeSourceAvailability: RelayAgentSourceAvailability | null;
  readonly sources: RelayAgentAuthorityIndex<RelayAgentSourceAuthorityState>;
  readonly dedupe: RelayAgentAuthorityIndex<RelayAgentSourceDedupeEvidence>;
  readonly runs: RelayAgentAuthorityIndex<RelayAgentRunRecord>;
  readonly turns: RelayAgentAuthorityIndex<RelayAgentTurnRecord>;
  readonly activeTurns: RelayAgentAuthorityIndex<RelayAgentActiveTurnIndexRecord>;
  readonly entries: RelayAgentAuthorityIndex<RelayAgentTextEntryRecord>;
  readonly deletedEntries: RelayAgentAuthorityIndex<RelayAgentDeletedEntryTombstone>;
}

export interface RelayAgentAuthoritySnapshotIndexEntry<K, V> {
  key: K;
  value: V;
}

/** Closed internal restore schema; it is neither a public wire snapshot nor a durable store adapter. */
export interface RelayAgentAuthoritySnapshotV1 {
  schemaVersion: 1;
  binding: RelayAgentAuthorityBinding;
  limits: RelayAgentAuthorityLimits;
  agentEventSeq: string;
  activeSourceEpoch: string | null;
  activeSourceAvailability: RelayAgentSourceAvailability | null;
  sources: readonly RelayAgentAuthoritySnapshotIndexEntry<string, RelayAgentSourceAuthorityState>[];
  dedupe: readonly RelayAgentAuthoritySnapshotIndexEntry<
    { sourceEpoch: string; sourceEventId: string },
    RelayAgentSourceDedupeEvidence
  >[];
  runs: readonly RelayAgentAuthoritySnapshotIndexEntry<string, RelayAgentRunRecord>[];
  turns: readonly RelayAgentAuthoritySnapshotIndexEntry<
    { runId: string; turnId: string },
    RelayAgentTurnRecord
  >[];
  activeTurns: readonly RelayAgentAuthoritySnapshotIndexEntry<string, RelayAgentActiveTurnIndexRecord>[];
  entries: readonly RelayAgentAuthoritySnapshotIndexEntry<string, RelayAgentTextEntryRecord>[];
  deletedEntries: readonly RelayAgentAuthoritySnapshotIndexEntry<string, RelayAgentDeletedEntryTombstone>[];
}

export type RelayAgentPublicMutation =
  | {
      mutationType: "source.availability";
      state: RelayAgentSourceAvailability;
      sourceEpoch: string;
      reason: "source_disconnected" | "source_restarted" | null;
    }
  | { mutationType: "lifecycle.changed"; lifecycle: RelayAgentLifecycleRecord }
  | { mutationType: "text_entry.appended"; entry: RelayAgentTextEntryRecord }
  | { mutationType: "entry.redacted"; entryId: string; reason: RelayAgentEntryRedactionReason }
  | { mutationType: "entry.deleted"; entryId: string; reason: RelayAgentEntryRedactionReason };

/** Internal host-authority record; it is not a public Relay frame. */
export interface RelayAgentAuthorityPublicEvent {
  hostId: string;
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  timelineEpoch: string;
  agentEventSeq: string;
  eventId: string;
  occurredAtMs: number;
  mutation: RelayAgentPublicMutation;
}

export interface RelayAgentAuthorityReduction {
  state: RelayAgentAuthorityState;
  disposition: RelayAgentAuthorityDisposition;
  agentEventSeq: string;
  expectedSourceSeq: string | null;
  publicEvent: RelayAgentAuthorityPublicEvent | null;
  sourceFenced: boolean;
}

export class RelayAgentAuthorityInputError extends TypeError {
  readonly code = "invalid_source_event" as const;
  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityInputError";
  }
}

export class RelayAgentAuthorityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityStateError";
  }
}

export class RelayAgentAuthorityRestoreError extends RelayAgentAuthorityStateError {
  readonly code = "authority_state_corrupt" as const;
  constructor(message: string) {
    super(message);
    this.name = "RelayAgentAuthorityRestoreError";
  }
}

export class RelayAgentAuthorityBindingError extends Error {
  constructor(
    readonly code: "adapter_binding_invalid" | "adapter_binding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "RelayAgentAuthorityBindingError";
  }
}

export class RelayAgentAuthorityCapacityError extends Error {
  readonly code = "authority_capacity_exceeded" as const;
  constructor(
    readonly resource: string,
    readonly limit: number,
    readonly attempted: number,
  ) {
    super(`Relay Agent authority ${resource} capacity is exhausted`);
    this.name = "RelayAgentAuthorityCapacityError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface TrieLeaf<V> {
  readonly kind: "leaf";
  readonly hash: string;
  readonly entries: readonly (readonly [string, V])[];
}

interface TrieBranch<V> {
  readonly kind: "branch";
  readonly children: readonly (TrieNode<V> | null)[];
}

type TrieNode<V> = TrieLeaf<V> | TrieBranch<V>;

function hashIndexKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function freezeLeaf<V>(hash: string, entries: readonly (readonly [string, V])[]): TrieLeaf<V> {
  return Object.freeze({
    kind: "leaf",
    hash,
    entries: Object.freeze(entries.map((entry) => Object.freeze([entry[0], entry[1]] as const))),
  });
}

function freezeBranch<V>(children: readonly (TrieNode<V> | null)[]): TrieBranch<V> {
  return Object.freeze({ kind: "branch", children: Object.freeze([...children]) });
}

function hashNibble(hash: string, depth: number): number {
  return Number.parseInt(hash[depth]!, 16);
}

function mergeLeaves<V>(left: TrieLeaf<V>, right: TrieLeaf<V>, depth: number): TrieNode<V> {
  if (depth >= 64 || left.hash === right.hash) {
    return freezeLeaf(left.hash, [...left.entries, ...right.entries]);
  }
  const leftIndex = hashNibble(left.hash, depth);
  const rightIndex = hashNibble(right.hash, depth);
  const children = Array<TrieNode<V> | null>(16).fill(null);
  if (leftIndex === rightIndex) {
    children[leftIndex] = mergeLeaves(left, right, depth + 1);
  } else {
    children[leftIndex] = left;
    children[rightIndex] = right;
  }
  return freezeBranch(children);
}

function trieGet<V>(node: TrieNode<V> | null, key: string, hash: string, depth = 0): V | undefined {
  if (node === null) return undefined;
  if (node.kind === "leaf") {
    if (node.hash !== hash) return undefined;
    return node.entries.find((entry) => entry[0] === key)?.[1];
  }
  return trieGet(node.children[hashNibble(hash, depth)] ?? null, key, hash, depth + 1);
}

function trieSet<V>(
  node: TrieNode<V> | null,
  key: string,
  hash: string,
  value: V,
  depth = 0,
): { node: TrieNode<V>; added: boolean } {
  if (node === null) return { node: freezeLeaf(hash, [[key, value]]), added: true };
  if (node.kind === "leaf") {
    if (node.hash !== hash) {
      return { node: mergeLeaves(node, freezeLeaf(hash, [[key, value]]), depth), added: true };
    }
    const existingIndex = node.entries.findIndex((entry) => entry[0] === key);
    if (existingIndex < 0) {
      return { node: freezeLeaf(hash, [...node.entries, [key, value]]), added: true };
    }
    const entries = [...node.entries];
    entries[existingIndex] = [key, value];
    return { node: freezeLeaf(hash, entries), added: false };
  }
  const childIndex = hashNibble(hash, depth);
  const child = trieSet(node.children[childIndex] ?? null, key, hash, value, depth + 1);
  const children = [...node.children];
  children[childIndex] = child.node;
  return { node: freezeBranch(children), added: child.added };
}

function trieDelete<V>(
  node: TrieNode<V> | null,
  key: string,
  hash: string,
  depth = 0,
): { node: TrieNode<V> | null; deleted: boolean } {
  if (node === null) return { node, deleted: false };
  if (node.kind === "leaf") {
    if (node.hash !== hash) return { node, deleted: false };
    const entries = node.entries.filter((entry) => entry[0] !== key);
    if (entries.length === node.entries.length) return { node, deleted: false };
    return { node: entries.length === 0 ? null : freezeLeaf(hash, entries), deleted: true };
  }
  const childIndex = hashNibble(hash, depth);
  const child = trieDelete(node.children[childIndex] ?? null, key, hash, depth + 1);
  if (!child.deleted) return { node, deleted: false };
  const children = [...node.children];
  children[childIndex] = child.node;
  const remaining = children.filter((candidate): candidate is TrieNode<V> => candidate !== null);
  if (remaining.length === 0) return { node: null, deleted: true };
  if (remaining.length === 1 && remaining[0]!.kind === "leaf") {
    return { node: remaining[0]!, deleted: true };
  }
  return { node: freezeBranch(children), deleted: true };
}

function* trieEntries<V>(node: TrieNode<V> | null): IterableIterator<readonly [string, V]> {
  if (node === null) return;
  if (node.kind === "leaf") {
    yield* node.entries;
    return;
  }
  for (const child of node.children) yield* trieEntries(child);
}

class PersistentStringIndex<V> implements RelayAgentAuthorityIndex<V> {
  readonly #root: TrieNode<V> | null;
  readonly size: number;

  private constructor(root: TrieNode<V> | null, size: number) {
    this.#root = root;
    this.size = size;
    Object.freeze(this);
  }

  static empty<V>(): PersistentStringIndex<V> {
    return new PersistentStringIndex<V>(null, 0);
  }

  get(key: string): V | undefined {
    return trieGet(this.#root, key, hashIndexKey(key));
  }

  set(key: string, value: V): PersistentStringIndex<V> {
    const updated = trieSet(this.#root, key, hashIndexKey(key), value);
    return new PersistentStringIndex(updated.node, this.size + (updated.added ? 1 : 0));
  }

  delete(key: string): PersistentStringIndex<V> {
    const updated = trieDelete(this.#root, key, hashIndexKey(key));
    return updated.deleted
      ? new PersistentStringIndex(updated.node, this.size - 1)
      : this;
  }

  *entries(): IterableIterator<readonly [string, V]> {
    yield* trieEntries(this.#root);
  }

  *values(): IterableIterator<V> {
    for (const [, value] of trieEntries(this.#root)) yield value;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`
  )).join(",")}}`;
}

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value as Json), "utf8");
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new RelayAgentAuthorityInputError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RelayAgentAuthorityInputError(`${label} contains an unpaired surrogate`);
    }
  }
}

function utf8Bytes(value: string, label: string): number {
  assertWellFormedUnicode(value, label);
  return Buffer.byteLength(value, "utf8");
}

function parseOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new RelayAgentAuthorityInputError(`${label} must be a non-empty opaque ID`);
  }
  if (utf8Bytes(value, label) > MAX_ID_UTF8_BYTES) {
    throw new RelayAgentAuthorityInputError(`${label} exceeds ${MAX_ID_UTF8_BYTES} UTF-8 bytes`);
  }
  return value;
}

function parseText(value: unknown, label: string, maxBytes: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.length === 0)) {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  if (utf8Bytes(value, label) > maxBytes) {
    throw new RelayAgentAuthorityInputError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function parseSafeTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_INTEGER) {
    throw new RelayAgentAuthorityInputError(`${label} must be a non-negative JSON safe integer`);
  }
  return value as number;
}

function parseSafeCount(value: unknown, label: string): number {
  return parseSafeTimestamp(value, label);
}

function parseCounter(value: unknown, label: string, positive: boolean): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayAgentAuthorityInputError(`${label} must be a canonical unsigned decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (positive && parsed === 0n)) {
    throw new RelayAgentAuthorityInputError(`${label} is outside the accepted uint64 range`);
  }
  return value;
}

function incrementCounter(value: string, label: string): string {
  const next = BigInt(value) + 1n;
  if (next > UINT64_MAX) throw new RelayAgentAuthorityStateError(`${label} is exhausted`);
  return next.toString();
}

function asClosedObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayAgentAuthorityInputError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RelayAgentAuthorityInputError(`${label} must use its closed schema`);
  }
  return record;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new RelayAgentAuthorityInputError(`${label} must be an array`);
  return value;
}

function parseLifecycleState(value: unknown, label: string): RelayAgentLifecycleState {
  if (value !== "running" && value !== "waiting_for_user" && value !== "failed" && value !== "completed") {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  return value;
}

function parseAvailability(value: unknown, label: string): RelayAgentSourceAvailability {
  if (value !== "connected" && value !== "interrupted") {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  return value;
}

function parseRedactionReason(value: unknown, label: string): RelayAgentEntryRedactionReason {
  if (value !== "user_request" && value !== "policy" && value !== "retention") {
    throw new RelayAgentAuthorityInputError(`${label} is invalid`);
  }
  return value;
}

function parseFailure(value: unknown, state: RelayAgentLifecycleState, label: string): RelayAgentFailure | null {
  if (state !== "failed") {
    if (value !== null) throw new RelayAgentAuthorityInputError(`${label} must be null outside failed state`);
    return null;
  }
  const record = asClosedObject(value, label, ["code", "summary"]);
  return deepFreeze({
    code: parseOpaqueId(record.code, `${label}.code`),
    summary: record.summary === null
      ? null
      : parseText(record.summary, `${label}.summary`, MAX_FAILURE_SUMMARY_UTF8_BYTES, true),
  });
}

function parseLifecycleMutation(record: Record<string, unknown>): RelayAgentLifecycleChangedMutation {
  const scope = record.scope;
  if (scope !== "run" && scope !== "turn") {
    throw new RelayAgentAuthorityInputError("mutation.scope is invalid");
  }
  const state = parseLifecycleState(record.state, "mutation.state");
  const turnId = scope === "run"
    ? (() => {
        if (record.turnId !== null) throw new RelayAgentAuthorityInputError("run lifecycle must have turnId=null");
        return null;
      })()
    : parseOpaqueId(record.turnId, "mutation.turnId");
  return deepFreeze({
    mutationType: "lifecycle.changed",
    scope,
    runId: parseOpaqueId(record.runId, "mutation.runId"),
    turnId,
    state,
    failure: parseFailure(record.failure, state, "mutation.failure"),
  });
}

function parseMutation(value: unknown): RelayAgentSourceMutation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayAgentAuthorityInputError("mutation must be an object");
  }
  const mutationType = (value as Record<string, unknown>).mutationType;
  switch (mutationType) {
    case "source.started":
      asClosedObject(value, "mutation", ["mutationType"]);
      return Object.freeze({ mutationType });
    case "source.availability": { // ordered adapter fact, never inferred from process/timer/terminal
      const record = asClosedObject(value, "mutation", ["mutationType", "state", "reason"]);
      const state = parseAvailability(record.state, "mutation.state");
      const expectedReason = state === "interrupted" ? "source_disconnected" : "source_restarted";
      if (record.reason !== expectedReason) {
        throw new RelayAgentAuthorityInputError("source availability reason does not match state");
      }
      return Object.freeze({ mutationType, state, reason: expectedReason });
    }
    case "lifecycle.changed":
      return parseLifecycleMutation(asClosedObject(value, "mutation", [
        "mutationType", "scope", "runId", "turnId", "state", "failure",
      ]));
    case "text_entry.appended": {
      const record = asClosedObject(value, "mutation", [
        "mutationType", "entryId", "runId", "turnId", "role", "text", "commandId",
      ]);
      if (record.role !== "user" && record.role !== "agent") {
        throw new RelayAgentAuthorityInputError("mutation.role is invalid");
      }
      const commandId = record.commandId === null
        ? null
        : parseOpaqueId(record.commandId, "mutation.commandId");
      if (record.role === "agent" && commandId !== null) {
        throw new RelayAgentAuthorityInputError("agent entry must have commandId=null");
      }
      return deepFreeze({
        mutationType,
        entryId: parseOpaqueId(record.entryId, "mutation.entryId"),
        runId: parseOpaqueId(record.runId, "mutation.runId"),
        turnId: parseOpaqueId(record.turnId, "mutation.turnId"),
        role: record.role,
        text: parseText(record.text, "mutation.text", MAX_TEXT_UTF8_BYTES, true),
        commandId,
      });
    }
    case "entry.redacted":
    case "entry.deleted": {
      const record = asClosedObject(value, "mutation", ["mutationType", "entryId", "reason"]);
      return Object.freeze({
        mutationType,
        entryId: parseOpaqueId(record.entryId, "mutation.entryId"),
        reason: parseRedactionReason(record.reason, "mutation.reason"),
      });
    }
    default:
      throw new RelayAgentAuthorityInputError("mutation.mutationType is not accepted");
  }
}

function parseSourceEvent(value: unknown): RelayAgentSourceEvent {
  const record = asClosedObject(value, "source event", [
    "sourceEpoch", "sourceSeq", "sourceEventId", "occurredAtMs", "mutation",
  ]);
  return deepFreeze({
    sourceEpoch: parseOpaqueId(record.sourceEpoch, "sourceEpoch"),
    sourceSeq: parseCounter(record.sourceSeq, "sourceSeq", true),
    sourceEventId: parseOpaqueId(record.sourceEventId, "sourceEventId"),
    occurredAtMs: parseSafeTimestamp(record.occurredAtMs, "occurredAtMs"),
    mutation: parseMutation(record.mutation),
  });
}

function canonicalizeSourceEvent(event: RelayAgentSourceEvent): Json {
  return event as unknown as Json;
}

function fingerprintSourceEvent(event: RelayAgentSourceEvent): string {
  return createHash("sha256").update(canonicalJson(canonicalizeSourceEvent(event)), "utf8").digest("hex");
}

function compositeKey(first: string, second: string): string {
  return canonicalJson([first, second]);
}

export function getRelayAgentAuthorityTurn(
  state: RelayAgentAuthorityState,
  runId: string,
  turnId: string,
): RelayAgentTurnRecord | undefined {
  assertVerifiedState(state);
  return state.turns.get(compositeKey(runId, turnId));
}

export function getRelayAgentAuthorityDedupeEvidence(
  state: RelayAgentAuthorityState,
  sourceEpoch: string,
  sourceEventId: string,
): RelayAgentSourceDedupeEvidence | undefined {
  assertVerifiedState(state);
  return state.dedupe.get(compositeKey(sourceEpoch, sourceEventId));
}

function eventIdFor(binding: RelayAgentAuthorityBinding, agentEventSeq: string): string {
  const digest = createHash("sha256").update(canonicalJson({
    kind: "relay-agent-authority-event-v1",
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    scopeId: binding.scopeId,
    sessionId: binding.sessionId,
    timelineEpoch: binding.timelineEpoch,
    agentEventSeq,
  })).digest("hex");
  return `agent-event-${digest}`;
}

function isTerminal(state: RelayAgentLifecycleState): boolean {
  return state === "failed" || state === "completed";
}

function transitionAllowed(from: RelayAgentLifecycleState, to: RelayAgentLifecycleState): boolean {
  if (from === "running") return to === "waiting_for_user" || to === "failed" || to === "completed";
  if (from === "waiting_for_user") return to === "running" || to === "failed" || to === "completed";
  return false;
}

type ResourceName = "sources" | "dedupe" | "runs" | "turns" | "entries" | "tombstones" | "activeTurns";

const RESOURCE_USAGE_FIELDS = Object.freeze({
  sources: ["sourceCount", "sourceCanonicalBytes"],
  dedupe: ["dedupeEvidenceCount", "dedupeCanonicalBytes"],
  runs: ["runCount", "runCanonicalBytes"],
  turns: ["turnCount", "turnCanonicalBytes"],
  entries: ["entryCount", "entryCanonicalBytes"],
  tombstones: ["tombstoneCount", "tombstoneCanonicalBytes"],
  activeTurns: ["activeTurnIndexCount", "activeTurnIndexCanonicalBytes"],
} as const);

const RESOURCE_LIMIT_FIELDS = Object.freeze({
  sources: ["maxSourceCount", "maxSourceCanonicalBytes"],
  dedupe: ["maxDedupeEvidenceCount", "maxDedupeCanonicalBytes"],
  runs: ["maxRunCount", "maxRunCanonicalBytes"],
  turns: ["maxTurnCount", "maxTurnCanonicalBytes"],
  entries: ["maxEntryCount", "maxEntryCanonicalBytes"],
  tombstones: ["maxTombstoneCount", "maxTombstoneCanonicalBytes"],
  activeTurns: ["maxActiveTurnIndexCount", "maxActiveTurnIndexCanonicalBytes"],
} as const);

function emptyUsage(): RelayAgentAuthorityUsage {
  return {
    sourceCount: 0,
    sourceCanonicalBytes: 0,
    dedupeEvidenceCount: 0,
    dedupeCanonicalBytes: 0,
    runCount: 0,
    runCanonicalBytes: 0,
    turnCount: 0,
    turnCanonicalBytes: 0,
    entryCount: 0,
    entryCanonicalBytes: 0,
    tombstoneCount: 0,
    tombstoneCanonicalBytes: 0,
    activeTurnIndexCount: 0,
    activeTurnIndexCanonicalBytes: 0,
    totalCanonicalBytes: 0,
  };
}

function indexedBytes(key: string, value: unknown): number {
  return canonicalBytes({ key, value });
}

function adjustUsage(
  usage: Readonly<RelayAgentAuthorityUsage>,
  resource: ResourceName,
  key: string,
  previous: unknown | undefined,
  next: unknown | undefined,
): RelayAgentAuthorityUsage {
  const result = { ...usage } as RelayAgentAuthorityUsage & Record<string, number>;
  const [countField, byteField] = RESOURCE_USAGE_FIELDS[resource];
  const previousBytes = previous === undefined ? 0 : indexedBytes(key, previous);
  const nextBytes = next === undefined ? 0 : indexedBytes(key, next);
  const previousCount = result[countField];
  const countDelta = (next === undefined ? 0 : 1) - (previous === undefined ? 0 : 1);
  const separatorDelta = previous === undefined && next !== undefined
    ? (previousCount > 0 ? 1 : 0)
    : previous !== undefined && next === undefined
      ? (previousCount > 1 ? -1 : 0)
      : 0;
  const byteDelta = nextBytes - previousBytes + separatorDelta;
  result[countField] += countDelta;
  result[byteField] += byteDelta;
  result.totalCanonicalBytes += byteDelta;
  return result;
}

function setIndexed<V>(
  index: PersistentStringIndex<V>,
  usage: Readonly<RelayAgentAuthorityUsage>,
  resource: ResourceName,
  key: string,
  value: V,
): readonly [PersistentStringIndex<V>, RelayAgentAuthorityUsage] {
  const previous = index.get(key);
  return [index.set(key, value), adjustUsage(usage, resource, key, previous, value)];
}

function deleteIndexed<V>(
  index: PersistentStringIndex<V>,
  usage: Readonly<RelayAgentAuthorityUsage>,
  resource: ResourceName,
  key: string,
): readonly [PersistentStringIndex<V>, RelayAgentAuthorityUsage] {
  const previous = index.get(key);
  if (previous === undefined) return [index, { ...usage }];
  return [index.delete(key), adjustUsage(usage, resource, key, previous, undefined)];
}

function stateHeaderBytes(state: Omit<RelayAgentAuthorityState, "usage">): number {
  return canonicalBytes({
    schemaVersion: state.schemaVersion,
    binding: state.binding,
    limits: state.limits,
    agentEventSeq: state.agentEventSeq,
    activeSourceEpoch: state.activeSourceEpoch,
    activeSourceAvailability: state.activeSourceAvailability,
    sources: [],
    dedupe: [],
    runs: [],
    turns: [],
    activeTurns: [],
    entries: [],
    deletedEntries: [],
  });
}

function assertBudgets(limits: RelayAgentAuthorityLimits, usage: Readonly<RelayAgentAuthorityUsage>): void {
  for (const resource of Object.keys(RESOURCE_USAGE_FIELDS) as ResourceName[]) {
    const [countField, byteField] = RESOURCE_USAGE_FIELDS[resource];
    const [countLimitField, byteLimitField] = RESOURCE_LIMIT_FIELDS[resource];
    if (usage[countField] > limits[countLimitField]) {
      throw new RelayAgentAuthorityCapacityError(resource, limits[countLimitField], usage[countField]);
    }
    if (usage[byteField] > limits[byteLimitField]) {
      throw new RelayAgentAuthorityCapacityError(`${resource}_canonical_bytes`, limits[byteLimitField], usage[byteField]);
    }
  }
  if (usage.totalCanonicalBytes > limits.maxCanonicalBytes) {
    throw new RelayAgentAuthorityCapacityError(
      "total_canonical_bytes",
      limits.maxCanonicalBytes,
      usage.totalCanonicalBytes,
    );
  }
}

function sealVerifiedState(state: RelayAgentAuthorityState): RelayAgentAuthorityState {
  const sealed = Object.freeze(state);
  VERIFIED_STATES.add(sealed);
  return sealed;
}

function assertVerifiedState(value: unknown): asserts value is RelayAgentAuthorityState {
  if (
    value === null
    || typeof value !== "object"
    || !VERIFIED_STATES.has(value)
  ) {
    throw new RelayAgentAuthorityStateError(
      "Relay Agent authority reducer requires state returned by create or restore",
    );
  }
}

function commitState(
  state: RelayAgentAuthorityState,
  updates: Partial<RelayAgentAuthorityState>,
  resourceUsage: Readonly<RelayAgentAuthorityUsage>,
): RelayAgentAuthorityState {
  const candidate = { ...state, ...updates } as RelayAgentAuthorityState;
  const usage = {
    ...resourceUsage,
    totalCanonicalBytes: resourceUsage.totalCanonicalBytes
      + stateHeaderBytes(candidate)
      - stateHeaderBytes(state),
  };
  assertBudgets(candidate.limits, usage);
  return sealVerifiedState({ ...candidate, usage: Object.freeze(usage) });
}

function result(
  state: RelayAgentAuthorityState,
  disposition: RelayAgentAuthorityDisposition,
  options: {
    expectedSourceSeq?: string | null;
    publicEvent?: RelayAgentAuthorityPublicEvent | null;
    sourceFenced?: boolean;
  } = {},
): RelayAgentAuthorityReduction {
  return Object.freeze({
    state,
    disposition,
    agentEventSeq: state.agentEventSeq,
    expectedSourceSeq: options.expectedSourceSeq ?? null,
    publicEvent: options.publicEvent ?? null,
    sourceFenced: options.sourceFenced ?? false,
  });
}

function authorityLimits(override: RelayAgentAuthorityCapacityOverride | undefined): RelayAgentAuthorityLimits {
  if (override === undefined) return RELAY_AGENT_AUTHORITY_HARD_LIMITS;
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new RelayAgentAuthorityStateError("Relay Agent authority capacity override is invalid");
  }
  const hard = RELAY_AGENT_AUTHORITY_HARD_LIMITS as Record<string, number>;
  const next = { ...RELAY_AGENT_AUTHORITY_HARD_LIMITS } as Record<string, number>;
  for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(hard, key) || !Number.isSafeInteger(value) || value < 1 || value > hard[key]!) {
      throw new RelayAgentAuthorityStateError(
        "Relay Agent authority capacity override may only shrink declared production limits",
      );
    }
    next[key] = value;
  }
  return Object.freeze(next) as RelayAgentAuthorityLimits;
}

function parseBinding(value: unknown, label: string): Readonly<RelayAgentAuthorityBinding> {
  const record = asClosedObject(value, label, ["hostId", "hostEpoch", "scopeId", "sessionId", "timelineEpoch"]);
  return Object.freeze({
    hostId: parseOpaqueId(record.hostId, `${label}.hostId`),
    hostEpoch: parseOpaqueId(record.hostEpoch, `${label}.hostEpoch`),
    scopeId: parseOpaqueId(record.scopeId, `${label}.scopeId`),
    sessionId: parseOpaqueId(record.sessionId, `${label}.sessionId`),
    timelineEpoch: parseOpaqueId(record.timelineEpoch, `${label}.timelineEpoch`),
  });
}

function sameBinding(left: RelayAgentAuthorityBinding, right: RelayAgentAuthorityBinding): boolean {
  return left.hostId === right.hostId
    && left.hostEpoch === right.hostEpoch
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId
    && left.timelineEpoch === right.timelineEpoch;
}

function parseTrustedAdapterBinding(value: unknown): RelayAgentTrustedAdapterBinding {
  try {
    const record = asClosedObject(value, "trusted adapter binding", ["hostId", "hostEpoch", "scopeId", "sessionId"]);
    return Object.freeze({
      hostId: parseOpaqueId(record.hostId, "trustedAdapterBinding.hostId"),
      hostEpoch: parseOpaqueId(record.hostEpoch, "trustedAdapterBinding.hostEpoch"),
      scopeId: parseOpaqueId(record.scopeId, "trustedAdapterBinding.scopeId"),
      sessionId: parseOpaqueId(record.sessionId, "trustedAdapterBinding.sessionId"),
    });
  } catch (error) {
    if (error instanceof RelayAgentAuthorityInputError) {
      throw new RelayAgentAuthorityBindingError("adapter_binding_invalid", error.message);
    }
    throw error;
  }
}

function assertTrustedAdapterBinding(state: RelayAgentAuthorityState, value: unknown): void {
  const binding = parseTrustedAdapterBinding(value);
  if (
    binding.hostId !== state.binding.hostId
    || binding.hostEpoch !== state.binding.hostEpoch
    || binding.scopeId !== state.binding.scopeId
    || binding.sessionId !== state.binding.sessionId
  ) {
    throw new RelayAgentAuthorityBindingError(
      "adapter_binding_mismatch",
      "trusted adapter binding does not match the authority state owner",
    );
  }
}

function createEmptyState(
  binding: Readonly<RelayAgentAuthorityBinding>,
  limits: RelayAgentAuthorityLimits,
): RelayAgentAuthorityState {
  const stateWithoutUsage = {
    schemaVersion: 1 as const,
    binding,
    limits,
    agentEventSeq: "0",
    activeSourceEpoch: null,
    activeSourceAvailability: null,
    sources: PersistentStringIndex.empty<RelayAgentSourceAuthorityState>(),
    dedupe: PersistentStringIndex.empty<RelayAgentSourceDedupeEvidence>(),
    runs: PersistentStringIndex.empty<RelayAgentRunRecord>(),
    turns: PersistentStringIndex.empty<RelayAgentTurnRecord>(),
    activeTurns: PersistentStringIndex.empty<RelayAgentActiveTurnIndexRecord>(),
    entries: PersistentStringIndex.empty<RelayAgentTextEntryRecord>(),
    deletedEntries: PersistentStringIndex.empty<RelayAgentDeletedEntryTombstone>(),
  };
  const usage = Object.freeze({ ...emptyUsage(), totalCanonicalBytes: stateHeaderBytes(stateWithoutUsage) });
  assertBudgets(limits, usage);
  return sealVerifiedState({ ...stateWithoutUsage, usage });
}

export function createRelayAgentAuthorityState(
  binding: RelayAgentAuthorityBinding,
  capacityOverride?: RelayAgentAuthorityCapacityOverride,
): RelayAgentAuthorityState {
  return createEmptyState(parseBinding(binding, "authority binding"), authorityLimits(capacityOverride));
}

function parseSnapshotLimits(value: unknown): RelayAgentAuthorityLimits {
  const keys = Object.keys(RELAY_AGENT_AUTHORITY_HARD_LIMITS);
  const record = asClosedObject(value, "snapshot.limits", keys);
  const parsed: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const key of keys) {
    const number = record[key];
    if (!Number.isSafeInteger(number) || (number as number) < 1) {
      throw new RelayAgentAuthorityInputError(`snapshot.limits.${key} must be a positive safe integer`);
    }
    parsed[key] = number as number;
  }
  return authorityLimits(parsed as RelayAgentAuthorityCapacityOverride);
}

function parseSnapshotLifecycle(value: unknown, label: string): RelayAgentLifecycleRecord {
  const record = asClosedObject(value, label, [
    "recordType", "lifecycleEventId", "sourceEpoch", "scope", "runId", "turnId",
    "state", "failure", "occurredAtMs", "agentEventSeq",
  ]);
  if (record.recordType !== "lifecycle") {
    throw new RelayAgentAuthorityInputError(`${label}.recordType is invalid`);
  }
  const scope = record.scope;
  if (scope !== "run" && scope !== "turn") {
    throw new RelayAgentAuthorityInputError(`${label}.scope is invalid`);
  }
  const state = parseLifecycleState(record.state, `${label}.state`);
  const turnId = scope === "run"
    ? (() => {
        if (record.turnId !== null) throw new RelayAgentAuthorityInputError(`${label}.turnId must be null`);
        return null;
      })()
    : parseOpaqueId(record.turnId, `${label}.turnId`);
  return deepFreeze({
    recordType: "lifecycle",
    lifecycleEventId: parseOpaqueId(record.lifecycleEventId, `${label}.lifecycleEventId`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    scope,
    runId: parseOpaqueId(record.runId, `${label}.runId`),
    turnId,
    state,
    failure: parseFailure(record.failure, state, `${label}.failure`),
    occurredAtMs: parseSafeTimestamp(record.occurredAtMs, `${label}.occurredAtMs`),
    agentEventSeq: parseCounter(record.agentEventSeq, `${label}.agentEventSeq`, true),
  });
}

function parseSnapshotSource(value: unknown, label: string): RelayAgentSourceAuthorityState {
  const record = asClosedObject(value, label, [
    "sourceEpoch", "lastSourceSeq", "fenced", "availability", "availabilityEventId",
    "availabilityAgentEventSeq", "availabilityOccurredAtMs",
  ]);
  if (typeof record.fenced !== "boolean") {
    throw new RelayAgentAuthorityInputError(`${label}.fenced must be boolean`);
  }
  return Object.freeze({
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    lastSourceSeq: parseCounter(record.lastSourceSeq, `${label}.lastSourceSeq`, true),
    fenced: record.fenced,
    availability: parseAvailability(record.availability, `${label}.availability`),
    availabilityEventId: parseOpaqueId(record.availabilityEventId, `${label}.availabilityEventId`),
    availabilityAgentEventSeq: parseCounter(
      record.availabilityAgentEventSeq,
      `${label}.availabilityAgentEventSeq`,
      true,
    ),
    availabilityOccurredAtMs: parseSafeTimestamp(
      record.availabilityOccurredAtMs,
      `${label}.availabilityOccurredAtMs`,
    ),
  });
}

function parseSnapshotDedupe(value: unknown, label: string): RelayAgentSourceDedupeEvidence {
  const record = asClosedObject(value, label, [
    "sessionId", "timelineEpoch", "sourceEpoch", "sourceEventId", "sourceSeq",
    "fingerprintAlgorithm", "fingerprintDigest",
  ]);
  if (record.fingerprintAlgorithm !== "sha256-canonical-json") {
    throw new RelayAgentAuthorityInputError(`${label}.fingerprintAlgorithm is invalid`);
  }
  if (typeof record.fingerprintDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.fingerprintDigest)) {
    throw new RelayAgentAuthorityInputError(`${label}.fingerprintDigest is invalid`);
  }
  return Object.freeze({
    sessionId: parseOpaqueId(record.sessionId, `${label}.sessionId`),
    timelineEpoch: parseOpaqueId(record.timelineEpoch, `${label}.timelineEpoch`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    sourceEventId: parseOpaqueId(record.sourceEventId, `${label}.sourceEventId`),
    sourceSeq: parseCounter(record.sourceSeq, `${label}.sourceSeq`, true),
    fingerprintAlgorithm: "sha256-canonical-json",
    fingerprintDigest: record.fingerprintDigest,
  });
}

function parseSnapshotRun(value: unknown, label: string): RelayAgentRunRecord {
  const record = asClosedObject(value, label, ["runId", "sourceEpoch", "state", "turnCount", "lifecycle"]);
  return deepFreeze({
    runId: parseOpaqueId(record.runId, `${label}.runId`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    state: parseLifecycleState(record.state, `${label}.state`),
    turnCount: parseSafeCount(record.turnCount, `${label}.turnCount`),
    lifecycle: parseSnapshotLifecycle(record.lifecycle, `${label}.lifecycle`),
  });
}

function parseSnapshotTurn(value: unknown, label: string): RelayAgentTurnRecord {
  const record = asClosedObject(value, label, ["turnId", "runId", "sourceEpoch", "state", "lifecycle"]);
  return deepFreeze({
    turnId: parseOpaqueId(record.turnId, `${label}.turnId`),
    runId: parseOpaqueId(record.runId, `${label}.runId`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    state: parseLifecycleState(record.state, `${label}.state`),
    lifecycle: parseSnapshotLifecycle(record.lifecycle, `${label}.lifecycle`),
  });
}

function parseSnapshotActiveTurn(value: unknown, label: string): RelayAgentActiveTurnIndexRecord {
  const record = asClosedObject(value, label, ["runId", "turnId", "sourceEpoch"]);
  return Object.freeze({
    runId: parseOpaqueId(record.runId, `${label}.runId`),
    turnId: parseOpaqueId(record.turnId, `${label}.turnId`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
  });
}

function parseSnapshotEntry(value: unknown, label: string): RelayAgentTextEntryRecord {
  const record = asClosedObject(value, label, [
    "recordType", "entryId", "runId", "turnId", "role", "state", "text",
    "redactionReason", "commandId", "createdAtMs", "createdAgentSeq", "lastModifiedAgentSeq",
  ]);
  if (record.recordType !== "text_entry") {
    throw new RelayAgentAuthorityInputError(`${label}.recordType is invalid`);
  }
  if (record.role !== "user" && record.role !== "agent") {
    throw new RelayAgentAuthorityInputError(`${label}.role is invalid`);
  }
  if (record.state !== "visible" && record.state !== "redacted") {
    throw new RelayAgentAuthorityInputError(`${label}.state is invalid`);
  }
  const commandId = record.commandId === null
    ? null
    : parseOpaqueId(record.commandId, `${label}.commandId`);
  if (record.role === "agent" && commandId !== null) {
    throw new RelayAgentAuthorityInputError(`${label} agent entry must have commandId=null`);
  }
  const text = record.state === "visible"
    ? parseText(record.text, `${label}.text`, MAX_TEXT_UTF8_BYTES, true)
    : (() => {
        if (record.text !== null) throw new RelayAgentAuthorityInputError(`${label}.text must be null`);
        return null;
      })();
  const redactionReason = record.state === "visible"
    ? (() => {
        if (record.redactionReason !== null) {
          throw new RelayAgentAuthorityInputError(`${label}.redactionReason must be null`);
        }
        return null;
      })()
    : parseRedactionReason(record.redactionReason, `${label}.redactionReason`);
  return deepFreeze({
    recordType: "text_entry",
    entryId: parseOpaqueId(record.entryId, `${label}.entryId`),
    runId: parseOpaqueId(record.runId, `${label}.runId`),
    turnId: parseOpaqueId(record.turnId, `${label}.turnId`),
    role: record.role,
    state: record.state,
    text,
    redactionReason,
    commandId,
    createdAtMs: parseSafeTimestamp(record.createdAtMs, `${label}.createdAtMs`),
    createdAgentSeq: parseCounter(record.createdAgentSeq, `${label}.createdAgentSeq`, true),
    lastModifiedAgentSeq: parseCounter(record.lastModifiedAgentSeq, `${label}.lastModifiedAgentSeq`, true),
  });
}

function parseSnapshotTombstone(value: unknown, label: string): RelayAgentDeletedEntryTombstone {
  const record = asClosedObject(value, label, ["entryId", "sourceEpoch", "reason", "deletedAgentSeq"]);
  return Object.freeze({
    entryId: parseOpaqueId(record.entryId, `${label}.entryId`),
    sourceEpoch: parseOpaqueId(record.sourceEpoch, `${label}.sourceEpoch`),
    reason: parseRedactionReason(record.reason, `${label}.reason`),
    deletedAgentSeq: parseCounter(record.deletedAgentSeq, `${label}.deletedAgentSeq`, true),
  });
}

function restoreFailure(message: string): never {
  throw new RelayAgentAuthorityRestoreError(message);
}

function assertSequenceAtOrBefore(sequence: string, current: string, label: string): void {
  if (BigInt(sequence) > BigInt(current)) restoreFailure(`${label} is ahead of snapshot.agentEventSeq`);
}

/**
 * The only JSON/plain-object rehydration boundary. It validates the complete
 * closed snapshot and normalizes it once into immutable, index-safe persistent
 * indexes. This proves structural integrity only: a future durable store must
 * reject valid-but-old rollback with its own atomic continuity watermark.
 */
export function restoreRelayAgentAuthorityState(
  snapshotInput: unknown,
  trustedBindingInput: RelayAgentAuthorityBinding,
): RelayAgentAuthorityState {
  try {
    const trustedBinding = parseBinding(trustedBindingInput, "trusted authority binding");
    const snapshot = asClosedObject(snapshotInput, "authority snapshot", [
      "schemaVersion", "binding", "limits", "agentEventSeq", "activeSourceEpoch",
      "activeSourceAvailability", "sources", "dedupe", "runs", "turns", "activeTurns",
      "entries", "deletedEntries",
    ]);
    if (snapshot.schemaVersion !== 1) restoreFailure("authority snapshot schemaVersion must equal 1");
    const binding = parseBinding(snapshot.binding, "snapshot.binding");
    if (!sameBinding(binding, trustedBinding)) restoreFailure("authority snapshot binding/lineage mismatch");
    const limits = parseSnapshotLimits(snapshot.limits);
    const agentEventSeq = parseCounter(snapshot.agentEventSeq, "snapshot.agentEventSeq", false);
    const activeSourceEpoch = snapshot.activeSourceEpoch === null
      ? null
      : parseOpaqueId(snapshot.activeSourceEpoch, "snapshot.activeSourceEpoch");
    const activeSourceAvailability = snapshot.activeSourceAvailability === null
      ? null
      : parseAvailability(snapshot.activeSourceAvailability, "snapshot.activeSourceAvailability");
    if ((activeSourceEpoch === null) !== (activeSourceAvailability === null)) {
      restoreFailure("active source epoch and availability nullability must match");
    }

    let usage = emptyUsage();
    let sources = PersistentStringIndex.empty<RelayAgentSourceAuthorityState>();
    const observedSequences = new Map<string, string>();
    let maxObservedSequence = 0n;
    const observeSequence = (sequence: string, owner: string): void => {
      assertSequenceAtOrBefore(sequence, agentEventSeq, owner);
      const existing = observedSequences.get(sequence);
      if (existing !== undefined && existing !== owner) restoreFailure(`public sequence ${sequence} is reused`);
      observedSequences.set(sequence, owner);
      if (BigInt(sequence) > maxObservedSequence) maxObservedSequence = BigInt(sequence);
    };

    for (const [index, item] of asArray(snapshot.sources, "snapshot.sources").entries()) {
      const keyed = asClosedObject(item, `snapshot.sources[${index}]`, ["key", "value"]);
      const key = parseOpaqueId(keyed.key, `snapshot.sources[${index}].key`);
      const value = parseSnapshotSource(keyed.value, `snapshot.sources[${index}].value`);
      if (key !== value.sourceEpoch) restoreFailure(`snapshot.sources[${index}] key mirror mismatch`);
      if (sources.get(key)) restoreFailure(`snapshot.sources[${index}] duplicate key`);
      if (value.availabilityEventId !== eventIdFor(binding, value.availabilityAgentEventSeq)) {
        restoreFailure(`snapshot.sources[${index}] availability event mirror mismatch`);
      }
      observeSequence(value.availabilityAgentEventSeq, `source:${key}:availability`);
      [sources, usage] = setIndexed(sources, usage, "sources", key, value);
      assertBudgets(limits, usage);
    }

    if (activeSourceEpoch !== null) {
      const active = sources.get(activeSourceEpoch);
      if (!active || active.availability !== activeSourceAvailability) {
        restoreFailure("active source mirror is missing or inconsistent");
      }
    }

    let dedupe = PersistentStringIndex.empty<RelayAgentSourceDedupeEvidence>();
    const sourceSequences = new Set<string>();
    for (const [index, item] of asArray(snapshot.dedupe, "snapshot.dedupe").entries()) {
      const keyed = asClosedObject(item, `snapshot.dedupe[${index}]`, ["key", "value"]);
      const keyObject = asClosedObject(keyed.key, `snapshot.dedupe[${index}].key`, ["sourceEpoch", "sourceEventId"]);
      const sourceEpoch = parseOpaqueId(keyObject.sourceEpoch, `snapshot.dedupe[${index}].key.sourceEpoch`);
      const sourceEventId = parseOpaqueId(keyObject.sourceEventId, `snapshot.dedupe[${index}].key.sourceEventId`);
      const value = parseSnapshotDedupe(keyed.value, `snapshot.dedupe[${index}].value`);
      if (value.sourceEpoch !== sourceEpoch || value.sourceEventId !== sourceEventId) {
        restoreFailure(`snapshot.dedupe[${index}] key mirror mismatch`);
      }
      if (value.sessionId !== binding.sessionId || value.timelineEpoch !== binding.timelineEpoch) {
        restoreFailure(`snapshot.dedupe[${index}] binding mirror mismatch`);
      }
      const source = sources.get(sourceEpoch);
      if (!source || BigInt(value.sourceSeq) > BigInt(source.lastSourceSeq)) {
        restoreFailure(`snapshot.dedupe[${index}] source cursor mismatch`);
      }
      const sequenceKey = compositeKey(sourceEpoch, value.sourceSeq);
      if (sourceSequences.has(sequenceKey)) restoreFailure(`snapshot.dedupe[${index}] sourceSeq is reused`);
      sourceSequences.add(sequenceKey);
      const key = compositeKey(sourceEpoch, sourceEventId);
      if (dedupe.get(key)) restoreFailure(`snapshot.dedupe[${index}] duplicate key`);
      [dedupe, usage] = setIndexed(dedupe, usage, "dedupe", key, value);
      assertBudgets(limits, usage);
    }

    let runs = PersistentStringIndex.empty<RelayAgentRunRecord>();
    for (const [index, item] of asArray(snapshot.runs, "snapshot.runs").entries()) {
      const keyed = asClosedObject(item, `snapshot.runs[${index}]`, ["key", "value"]);
      const key = parseOpaqueId(keyed.key, `snapshot.runs[${index}].key`);
      const value = parseSnapshotRun(keyed.value, `snapshot.runs[${index}].value`);
      if (key !== value.runId) restoreFailure(`snapshot.runs[${index}] key mirror mismatch`);
      if (runs.get(key)) restoreFailure(`snapshot.runs[${index}] duplicate key`);
      if (!sources.get(value.sourceEpoch)) restoreFailure(`snapshot.runs[${index}] source is missing`);
      const lifecycle = value.lifecycle;
      if (
        lifecycle.scope !== "run" || lifecycle.turnId !== null || lifecycle.runId !== value.runId
        || lifecycle.sourceEpoch !== value.sourceEpoch || lifecycle.state !== value.state
        || lifecycle.lifecycleEventId !== eventIdFor(binding, lifecycle.agentEventSeq)
      ) {
        restoreFailure(`snapshot.runs[${index}] lifecycle mirror mismatch`);
      }
      observeSequence(lifecycle.agentEventSeq, `run:${key}:lifecycle`);
      [runs, usage] = setIndexed(runs, usage, "runs", key, value);
      assertBudgets(limits, usage);
    }

    let turns = PersistentStringIndex.empty<RelayAgentTurnRecord>();
    const turnCounts = new Map<string, number>();
    for (const [index, item] of asArray(snapshot.turns, "snapshot.turns").entries()) {
      const keyed = asClosedObject(item, `snapshot.turns[${index}]`, ["key", "value"]);
      const keyObject = asClosedObject(keyed.key, `snapshot.turns[${index}].key`, ["runId", "turnId"]);
      const runId = parseOpaqueId(keyObject.runId, `snapshot.turns[${index}].key.runId`);
      const turnId = parseOpaqueId(keyObject.turnId, `snapshot.turns[${index}].key.turnId`);
      const value = parseSnapshotTurn(keyed.value, `snapshot.turns[${index}].value`);
      if (value.runId !== runId || value.turnId !== turnId) restoreFailure(`snapshot.turns[${index}] key mirror mismatch`);
      const run = runs.get(runId);
      if (!run || run.sourceEpoch !== value.sourceEpoch) restoreFailure(`snapshot.turns[${index}] run/source mirror mismatch`);
      const lifecycle = value.lifecycle;
      if (
        lifecycle.scope !== "turn" || lifecycle.runId !== runId || lifecycle.turnId !== turnId
        || lifecycle.sourceEpoch !== value.sourceEpoch || lifecycle.state !== value.state
        || lifecycle.lifecycleEventId !== eventIdFor(binding, lifecycle.agentEventSeq)
      ) {
        restoreFailure(`snapshot.turns[${index}] lifecycle mirror mismatch`);
      }
      const key = compositeKey(runId, turnId);
      if (turns.get(key)) restoreFailure(`snapshot.turns[${index}] duplicate key`);
      observeSequence(lifecycle.agentEventSeq, `turn:${key}:lifecycle`);
      turnCounts.set(runId, (turnCounts.get(runId) ?? 0) + 1);
      [turns, usage] = setIndexed(turns, usage, "turns", key, value);
      assertBudgets(limits, usage);
    }

    let activeTurns = PersistentStringIndex.empty<RelayAgentActiveTurnIndexRecord>();
    for (const [index, item] of asArray(snapshot.activeTurns, "snapshot.activeTurns").entries()) {
      const keyed = asClosedObject(item, `snapshot.activeTurns[${index}]`, ["key", "value"]);
      const key = parseOpaqueId(keyed.key, `snapshot.activeTurns[${index}].key`);
      const value = parseSnapshotActiveTurn(keyed.value, `snapshot.activeTurns[${index}].value`);
      if (key !== value.runId) restoreFailure(`snapshot.activeTurns[${index}] key mirror mismatch`);
      const run = runs.get(key);
      const turn = turns.get(compositeKey(value.runId, value.turnId));
      if (
        !run || !turn || isTerminal(turn.state)
        || run.sourceEpoch !== value.sourceEpoch || turn.sourceEpoch !== value.sourceEpoch
      ) {
        restoreFailure(`snapshot.activeTurns[${index}] target mirror mismatch`);
      }
      if (activeTurns.get(key)) restoreFailure(`snapshot.activeTurns[${index}] duplicate key`);
      [activeTurns, usage] = setIndexed(activeTurns, usage, "activeTurns", key, value);
      assertBudgets(limits, usage);
    }

    for (const run of runs.values()) {
      if (run.turnCount !== (turnCounts.get(run.runId) ?? 0)) restoreFailure(`run ${run.runId} turnCount mismatch`);
      const active = activeTurns.get(run.runId);
      if (isTerminal(run.state) && active) restoreFailure(`terminal run ${run.runId} has an active turn`);
      if (run.state === "waiting_for_user" && active) {
        const turn = turns.get(compositeKey(active.runId, active.turnId))!;
        if (turn.state !== "waiting_for_user") restoreFailure(`waiting run ${run.runId} active turn mismatch`);
      }
    }
    for (const turn of turns.values()) {
      const active = activeTurns.get(turn.runId);
      if (!isTerminal(turn.state) && active?.turnId !== turn.turnId) {
        restoreFailure(`nonterminal turn ${turn.runId}/${turn.turnId} lacks its active index`);
      }
      if (isTerminal(turn.state) && active?.turnId === turn.turnId) {
        restoreFailure(`terminal turn ${turn.runId}/${turn.turnId} remains active`);
      }
    }

    let entries = PersistentStringIndex.empty<RelayAgentTextEntryRecord>();
    for (const [index, item] of asArray(snapshot.entries, "snapshot.entries").entries()) {
      const keyed = asClosedObject(item, `snapshot.entries[${index}]`, ["key", "value"]);
      const key = parseOpaqueId(keyed.key, `snapshot.entries[${index}].key`);
      const value = parseSnapshotEntry(keyed.value, `snapshot.entries[${index}].value`);
      if (key !== value.entryId) restoreFailure(`snapshot.entries[${index}] key mirror mismatch`);
      if (entries.get(key)) restoreFailure(`snapshot.entries[${index}] duplicate key`);
      const run = runs.get(value.runId);
      const turn = turns.get(compositeKey(value.runId, value.turnId));
      if (!run || !turn || run.sourceEpoch !== turn.sourceEpoch) {
        restoreFailure(`snapshot.entries[${index}] run/turn binding mismatch`);
      }
      if (BigInt(value.createdAgentSeq) > BigInt(value.lastModifiedAgentSeq)) {
        restoreFailure(`snapshot.entries[${index}] sequence order mismatch`);
      }
      if (value.state === "visible" && value.createdAgentSeq !== value.lastModifiedAgentSeq) {
        restoreFailure(`snapshot.entries[${index}] visible sequence mirror mismatch`);
      }
      if (value.state === "redacted" && value.createdAgentSeq === value.lastModifiedAgentSeq) {
        restoreFailure(`snapshot.entries[${index}] redacted sequence mirror mismatch`);
      }
      observeSequence(value.createdAgentSeq, `entry:${key}:created`);
      observeSequence(value.lastModifiedAgentSeq, value.createdAgentSeq === value.lastModifiedAgentSeq
        ? `entry:${key}:created`
        : `entry:${key}:modified`);
      [entries, usage] = setIndexed(entries, usage, "entries", key, value);
      assertBudgets(limits, usage);
    }

    let deletedEntries = PersistentStringIndex.empty<RelayAgentDeletedEntryTombstone>();
    for (const [index, item] of asArray(snapshot.deletedEntries, "snapshot.deletedEntries").entries()) {
      const keyed = asClosedObject(item, `snapshot.deletedEntries[${index}]`, ["key", "value"]);
      const key = parseOpaqueId(keyed.key, `snapshot.deletedEntries[${index}].key`);
      const value = parseSnapshotTombstone(keyed.value, `snapshot.deletedEntries[${index}].value`);
      if (key !== value.entryId) restoreFailure(`snapshot.deletedEntries[${index}] key mirror mismatch`);
      if (entries.get(key) || deletedEntries.get(key)) {
        restoreFailure(`snapshot.deletedEntries[${index}] conflicts with materialized identity`);
      }
      if (!sources.get(value.sourceEpoch)) restoreFailure(`snapshot.deletedEntries[${index}] source is missing`);
      observeSequence(value.deletedAgentSeq, `tombstone:${key}:deleted`);
      [deletedEntries, usage] = setIndexed(deletedEntries, usage, "tombstones", key, value);
      assertBudgets(limits, usage);
    }

    if ((agentEventSeq === "0") !== (maxObservedSequence === 0n)) {
      restoreFailure("snapshot.agentEventSeq does not match materialized public record watermark");
    }
    if (agentEventSeq !== "0" && BigInt(agentEventSeq) !== maxObservedSequence) {
      restoreFailure("snapshot.agentEventSeq is not the materialized public record watermark");
    }

    const stateWithoutUsage = {
      schemaVersion: 1 as const,
      binding,
      limits,
      agentEventSeq,
      activeSourceEpoch,
      activeSourceAvailability,
      sources,
      dedupe,
      runs,
      turns,
      activeTurns,
      entries,
      deletedEntries,
    };
    usage.totalCanonicalBytes += stateHeaderBytes(stateWithoutUsage);
    assertBudgets(limits, usage);
    return sealVerifiedState({ ...stateWithoutUsage, usage: Object.freeze(usage) });
  } catch (error) {
    if (error instanceof RelayAgentAuthorityCapacityError || error instanceof RelayAgentAuthorityRestoreError) {
      throw error;
    }
    if (error instanceof Error) throw new RelayAgentAuthorityRestoreError(error.message);
    throw new RelayAgentAuthorityRestoreError("authority snapshot is corrupt");
  }
}

interface DomainReduction {
  disposition:
    | "applied"
    | "invalid_transition"
    | "redundant_terminal"
    | "terminal_conflict"
    | "entry_id_conflict"
    | "entry_deleted";
  runs: PersistentStringIndex<RelayAgentRunRecord>;
  turns: PersistentStringIndex<RelayAgentTurnRecord>;
  activeTurns: PersistentStringIndex<RelayAgentActiveTurnIndexRecord>;
  entries: PersistentStringIndex<RelayAgentTextEntryRecord>;
  deletedEntries: PersistentStringIndex<RelayAgentDeletedEntryTombstone>;
  usage: Readonly<RelayAgentAuthorityUsage>;
  publicMutation: RelayAgentPublicMutation | null;
}

function unchangedDomain(
  state: RelayAgentAuthorityState,
  disposition: Exclude<DomainReduction["disposition"], "applied">,
): DomainReduction {
  return {
    disposition,
    runs: state.runs as PersistentStringIndex<RelayAgentRunRecord>,
    turns: state.turns as PersistentStringIndex<RelayAgentTurnRecord>,
    activeTurns: state.activeTurns as PersistentStringIndex<RelayAgentActiveTurnIndexRecord>,
    entries: state.entries as PersistentStringIndex<RelayAgentTextEntryRecord>,
    deletedEntries: state.deletedEntries as PersistentStringIndex<RelayAgentDeletedEntryTombstone>,
    usage: state.usage,
    publicMutation: null,
  };
}

function lifecycleRecord(
  event: RelayAgentSourceEvent,
  mutation: RelayAgentLifecycleChangedMutation,
  agentEventSeq: string,
  eventId: string,
): RelayAgentLifecycleRecord {
  return deepFreeze({
    recordType: "lifecycle",
    lifecycleEventId: eventId,
    sourceEpoch: event.sourceEpoch,
    scope: mutation.scope,
    runId: mutation.runId,
    turnId: mutation.turnId,
    state: mutation.state,
    failure: mutation.failure,
    occurredAtMs: event.occurredAtMs,
    agentEventSeq,
  });
}

function reduceLifecycle(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentLifecycleChangedMutation,
  agentEventSeq: string,
  eventId: string,
): DomainReduction {
  const record = lifecycleRecord(event, mutation, agentEventSeq, eventId);
  let usage = state.usage;
  let runs = state.runs as PersistentStringIndex<RelayAgentRunRecord>;
  let turns = state.turns as PersistentStringIndex<RelayAgentTurnRecord>;
  let activeTurns = state.activeTurns as PersistentStringIndex<RelayAgentActiveTurnIndexRecord>;
  if (mutation.scope === "run") {
    const existing = runs.get(mutation.runId);
    if (!existing) {
      if (mutation.state !== "running") return unchangedDomain(state, "invalid_transition");
      const created = deepFreeze({
        runId: mutation.runId,
        sourceEpoch: event.sourceEpoch,
        state: mutation.state,
        turnCount: 0,
        lifecycle: record,
      });
      [runs, usage] = setIndexed(runs, usage, "runs", mutation.runId, created);
      return {
        ...unchangedDomain(state, "invalid_transition"),
        disposition: "applied",
        runs,
        usage,
        publicMutation: Object.freeze({ mutationType: "lifecycle.changed", lifecycle: record }),
      };
    }
    if (existing.sourceEpoch !== event.sourceEpoch) return unchangedDomain(state, "invalid_transition");
    if (isTerminal(existing.state)) {
      if (mutation.state === existing.state) return unchangedDomain(state, "redundant_terminal");
      return unchangedDomain(state, isTerminal(mutation.state) ? "terminal_conflict" : "invalid_transition");
    }
    if (!transitionAllowed(existing.state, mutation.state)) return unchangedDomain(state, "invalid_transition");
    const activeIndex = activeTurns.get(mutation.runId);
    const activeTurn = activeIndex
      ? turns.get(compositeKey(activeIndex.runId, activeIndex.turnId))
      : undefined;
    if (mutation.state === "waiting_for_user" && activeTurn?.state !== undefined && activeTurn.state !== "waiting_for_user") {
      return unchangedDomain(state, "invalid_transition");
    }
    if (isTerminal(mutation.state) && activeIndex !== undefined) {
      return unchangedDomain(state, "invalid_transition");
    }
    const updated = deepFreeze({ ...existing, state: mutation.state, lifecycle: record });
    [runs, usage] = setIndexed(runs, usage, "runs", mutation.runId, updated);
    return {
      ...unchangedDomain(state, "invalid_transition"),
      disposition: "applied",
      runs,
      usage,
      publicMutation: Object.freeze({ mutationType: "lifecycle.changed", lifecycle: record }),
    };
  }

  const turnId = mutation.turnId!;
  const key = compositeKey(mutation.runId, turnId);
  const run = runs.get(mutation.runId);
  if (!run || run.sourceEpoch !== event.sourceEpoch) return unchangedDomain(state, "invalid_transition");
  const existing = turns.get(key);
  if (!existing) {
    if (mutation.state !== "running" || run.state !== "running" || activeTurns.get(run.runId)) {
      return unchangedDomain(state, "invalid_transition");
    }
    const created = deepFreeze({
      turnId,
      runId: mutation.runId,
      sourceEpoch: event.sourceEpoch,
      state: mutation.state,
      lifecycle: record,
    });
    [turns, usage] = setIndexed(turns, usage, "turns", key, created);
    [runs, usage] = setIndexed(runs, usage, "runs", run.runId, deepFreeze({
      ...run,
      turnCount: run.turnCount + 1,
    }));
    [activeTurns, usage] = setIndexed(activeTurns, usage, "activeTurns", run.runId, Object.freeze({
      runId: run.runId,
      turnId,
      sourceEpoch: event.sourceEpoch,
    }));
    return {
      ...unchangedDomain(state, "invalid_transition"),
      disposition: "applied",
      runs,
      turns,
      activeTurns,
      usage,
      publicMutation: Object.freeze({ mutationType: "lifecycle.changed", lifecycle: record }),
    };
  }
  if (existing.sourceEpoch !== event.sourceEpoch || existing.runId !== mutation.runId) {
    return unchangedDomain(state, "invalid_transition");
  }
  if (isTerminal(existing.state)) {
    if (mutation.state === existing.state) return unchangedDomain(state, "redundant_terminal");
    return unchangedDomain(state, isTerminal(mutation.state) ? "terminal_conflict" : "invalid_transition");
  }
  if (!transitionAllowed(existing.state, mutation.state)) return unchangedDomain(state, "invalid_transition");
  if (mutation.state === "running" && run.state !== "running") return unchangedDomain(state, "invalid_transition");
  if (isTerminal(run.state)) return unchangedDomain(state, "invalid_transition");
  const active = activeTurns.get(run.runId);
  if (!active || active.turnId !== turnId) return unchangedDomain(state, "invalid_transition");
  [turns, usage] = setIndexed(turns, usage, "turns", key, deepFreeze({
    ...existing,
    state: mutation.state,
    lifecycle: record,
  }));
  if (isTerminal(mutation.state)) {
    [activeTurns, usage] = deleteIndexed(activeTurns, usage, "activeTurns", run.runId);
  }
  return {
    ...unchangedDomain(state, "invalid_transition"),
    disposition: "applied",
    turns,
    activeTurns,
    usage,
    publicMutation: Object.freeze({ mutationType: "lifecycle.changed", lifecycle: record }),
  };
}

function reduceEntryAppend(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentTextEntryAppendedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries.get(mutation.entryId)) return unchangedDomain(state, "entry_deleted");
  if (state.entries.get(mutation.entryId)) return unchangedDomain(state, "entry_id_conflict");
  const run = state.runs.get(mutation.runId);
  const turn = state.turns.get(compositeKey(mutation.runId, mutation.turnId));
  if (
    !run || !turn
    || run.sourceEpoch !== event.sourceEpoch
    || turn.sourceEpoch !== event.sourceEpoch
    || turn.runId !== mutation.runId
  ) {
    return unchangedDomain(state, "invalid_transition");
  }
  const allowed = mutation.role === "agent"
    ? turn.state === "running"
    : turn.state === "running" || turn.state === "waiting_for_user";
  if (!allowed) return unchangedDomain(state, "invalid_transition");
  const entry: RelayAgentTextEntryRecord = deepFreeze({
    recordType: "text_entry",
    entryId: mutation.entryId,
    runId: mutation.runId,
    turnId: mutation.turnId,
    role: mutation.role,
    state: "visible",
    text: mutation.text,
    redactionReason: null,
    commandId: mutation.commandId,
    createdAtMs: event.occurredAtMs,
    createdAgentSeq: agentEventSeq,
    lastModifiedAgentSeq: agentEventSeq,
  });
  let usage = state.usage;
  let entries = state.entries as PersistentStringIndex<RelayAgentTextEntryRecord>;
  [entries, usage] = setIndexed(entries, usage, "entries", mutation.entryId, entry);
  return {
    ...unchangedDomain(state, "invalid_transition"),
    disposition: "applied",
    entries,
    usage,
    publicMutation: Object.freeze({ mutationType: "text_entry.appended", entry }),
  };
}

function reduceEntryRedaction(
  state: RelayAgentAuthorityState,
  mutation: RelayAgentEntryRedactedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries.get(mutation.entryId)) return unchangedDomain(state, "entry_deleted");
  const existing = state.entries.get(mutation.entryId);
  if (!existing || existing.state !== "visible") return unchangedDomain(state, "invalid_transition");
  const updated = deepFreeze({
    ...existing,
    state: "redacted" as const,
    text: null,
    redactionReason: mutation.reason,
    lastModifiedAgentSeq: agentEventSeq,
  });
  let usage = state.usage;
  let entries = state.entries as PersistentStringIndex<RelayAgentTextEntryRecord>;
  [entries, usage] = setIndexed(entries, usage, "entries", mutation.entryId, updated);
  return {
    ...unchangedDomain(state, "invalid_transition"),
    disposition: "applied",
    entries,
    usage,
    publicMutation: Object.freeze({ mutationType: "entry.redacted", entryId: mutation.entryId, reason: mutation.reason }),
  };
}

function reduceEntryDelete(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  mutation: RelayAgentEntryDeletedMutation,
  agentEventSeq: string,
): DomainReduction {
  if (state.deletedEntries.get(mutation.entryId)) return unchangedDomain(state, "entry_deleted");
  if (!state.entries.get(mutation.entryId)) return unchangedDomain(state, "invalid_transition");
  let usage = state.usage;
  let entries = state.entries as PersistentStringIndex<RelayAgentTextEntryRecord>;
  let tombstones = state.deletedEntries as PersistentStringIndex<RelayAgentDeletedEntryTombstone>;
  [entries, usage] = deleteIndexed(entries, usage, "entries", mutation.entryId);
  [tombstones, usage] = setIndexed(tombstones, usage, "tombstones", mutation.entryId, Object.freeze({
    entryId: mutation.entryId,
    sourceEpoch: event.sourceEpoch,
    reason: mutation.reason,
    deletedAgentSeq: agentEventSeq,
  }));
  return {
    ...unchangedDomain(state, "invalid_transition"),
    disposition: "applied",
    entries,
    deletedEntries: tombstones,
    usage,
    publicMutation: Object.freeze({ mutationType: "entry.deleted", entryId: mutation.entryId, reason: mutation.reason }),
  };
}

function reduceDomain(
  state: RelayAgentAuthorityState,
  event: RelayAgentSourceEvent,
  agentEventSeq: string,
  eventId: string,
): DomainReduction {
  switch (event.mutation.mutationType) {
    case "source.started":
      return {
        ...unchangedDomain(state, "invalid_transition"),
        disposition: "applied",
        publicMutation: Object.freeze({
          mutationType: "source.availability",
          state: "connected",
          sourceEpoch: event.sourceEpoch,
          reason: state.activeSourceEpoch === null ? null : "source_restarted",
        }),
      };
    case "source.availability": {
      const source = state.sources.get(event.sourceEpoch)!;
      const expectedFrom = event.mutation.state === "connected" ? "interrupted" : "connected";
      if (source.availability !== expectedFrom) return unchangedDomain(state, "invalid_transition");
      return {
        ...unchangedDomain(state, "invalid_transition"),
        disposition: "applied",
        publicMutation: Object.freeze({
          mutationType: "source.availability",
          state: event.mutation.state,
          sourceEpoch: event.sourceEpoch,
          reason: event.mutation.reason,
        }),
      };
    }
    case "lifecycle.changed":
      if (state.activeSourceAvailability !== "connected") return unchangedDomain(state, "invalid_transition");
      return reduceLifecycle(state, event, event.mutation, agentEventSeq, eventId);
    case "text_entry.appended":
      if (state.activeSourceAvailability !== "connected") return unchangedDomain(state, "invalid_transition");
      return reduceEntryAppend(state, event, event.mutation, agentEventSeq);
    case "entry.redacted":
      if (state.activeSourceAvailability !== "connected") return unchangedDomain(state, "invalid_transition");
      return reduceEntryRedaction(state, event.mutation, agentEventSeq);
    case "entry.deleted":
      if (state.activeSourceAvailability !== "connected") return unchangedDomain(state, "invalid_transition");
      return reduceEntryDelete(state, event, event.mutation, agentEventSeq);
  }
}

function fenceSource(
  state: RelayAgentAuthorityState,
  source: RelayAgentSourceAuthorityState,
): RelayAgentAuthorityState {
  if (source.fenced) return state;
  const updated = Object.freeze({ ...source, fenced: true });
  let usage = state.usage;
  let sources = state.sources as PersistentStringIndex<RelayAgentSourceAuthorityState>;
  [sources, usage] = setIndexed(sources, usage, "sources", source.sourceEpoch, updated);
  return commitState(state, { sources }, usage);
}

/**
 * Pure transition over a create/restore-validated state. It returns a
 * persistent-index state/delta cut, not a durable commit. A future store must
 * atomically persist state and publicEvent, and must separately enforce a
 * continuity watermark; structural restore cannot detect a valid old snapshot.
 */
export function reduceRelayAgentAuthority(
  state: RelayAgentAuthorityState,
  sourceInput: unknown,
  trustedAdapterBinding: RelayAgentTrustedAdapterBinding,
): RelayAgentAuthorityReduction {
  assertVerifiedState(state);
  assertTrustedAdapterBinding(state, trustedAdapterBinding);
  const event = parseSourceEvent(sourceInput);
  const fingerprintDigest = fingerprintSourceEvent(event);
  const source = state.sources.get(event.sourceEpoch);

  if (state.activeSourceEpoch !== null && event.sourceEpoch !== state.activeSourceEpoch && source) {
    return result(state, "stale_source", { sourceFenced: source.fenced });
  }

  const retained = state.dedupe.get(compositeKey(event.sourceEpoch, event.sourceEventId));
  if (retained) {
    if (retained.fingerprintDigest === fingerprintDigest) {
      return result(state, "duplicate", { sourceFenced: source?.fenced ?? false });
    }
    const fencedState = source ? fenceSource(state, source) : state;
    return result(fencedState, "source_event_conflict", { sourceFenced: true });
  }

  if (source?.fenced) return result(state, "source_event_conflict", { sourceFenced: true });
  if (source && BigInt(event.sourceSeq) <= BigInt(source.lastSourceSeq)) {
    return result(state, "source_history_expired");
  }
  if (state.activeSourceEpoch !== null && event.sourceEpoch !== state.activeSourceEpoch && event.sourceSeq !== "1") {
    return result(state, "source_gap", { expectedSourceSeq: "1" });
  }

  const expectedSourceSeq = source ? incrementCounter(source.lastSourceSeq, "sourceSeq") : "1";
  if (event.sourceSeq !== expectedSourceSeq) return result(state, "source_gap", { expectedSourceSeq });
  if ((!source && event.mutation.mutationType !== "source.started") || (source && event.mutation.mutationType === "source.started")) {
    return result(state, "invalid_transition");
  }

  const nextAgentEventSeq = incrementCounter(state.agentEventSeq, "agentEventSeq");
  const eventId = eventIdFor(state.binding, nextAgentEventSeq);
  const domain = reduceDomain(state, event, nextAgentEventSeq, eventId);
  if (domain.disposition !== "applied" && domain.disposition !== "redundant_terminal") {
    return result(state, domain.disposition);
  }

  let usage = domain.usage;
  let sources = state.sources as PersistentStringIndex<RelayAgentSourceAuthorityState>;
  const availability = event.mutation.mutationType === "source.started"
    ? "connected"
    : event.mutation.mutationType === "source.availability"
      ? event.mutation.state
      : source!.availability;
  const nextSource: RelayAgentSourceAuthorityState = Object.freeze({
    sourceEpoch: event.sourceEpoch,
    lastSourceSeq: event.sourceSeq,
    fenced: false,
    availability,
    availabilityEventId: event.mutation.mutationType === "source.started" || event.mutation.mutationType === "source.availability"
      ? eventId
      : source!.availabilityEventId,
    availabilityAgentEventSeq: event.mutation.mutationType === "source.started" || event.mutation.mutationType === "source.availability"
      ? nextAgentEventSeq
      : source!.availabilityAgentEventSeq,
    availabilityOccurredAtMs: event.mutation.mutationType === "source.started" || event.mutation.mutationType === "source.availability"
      ? event.occurredAtMs
      : source!.availabilityOccurredAtMs,
  });
  [sources, usage] = setIndexed(sources, usage, "sources", event.sourceEpoch, nextSource);

  let dedupe = state.dedupe as PersistentStringIndex<RelayAgentSourceDedupeEvidence>;
  const dedupeKey = compositeKey(event.sourceEpoch, event.sourceEventId);
  [dedupe, usage] = setIndexed(dedupe, usage, "dedupe", dedupeKey, Object.freeze({
    sessionId: state.binding.sessionId,
    timelineEpoch: state.binding.timelineEpoch,
    sourceEpoch: event.sourceEpoch,
    sourceEventId: event.sourceEventId,
    sourceSeq: event.sourceSeq,
    fingerprintAlgorithm: "sha256-canonical-json",
    fingerprintDigest,
  }));

  const activeSourceEpoch = event.mutation.mutationType === "source.started"
    ? event.sourceEpoch
    : state.activeSourceEpoch;
  const activeSourceAvailability = event.mutation.mutationType === "source.started" || event.mutation.mutationType === "source.availability"
    ? availability
    : state.activeSourceAvailability;

  if (domain.disposition === "redundant_terminal") {
    const nextState = commitState(state, { sources, dedupe }, usage);
    return result(nextState, "redundant_terminal", { sourceFenced: nextSource.fenced });
  }

  const nextState = commitState(state, {
    agentEventSeq: nextAgentEventSeq,
    activeSourceEpoch,
    activeSourceAvailability,
    sources,
    dedupe,
    runs: domain.runs,
    turns: domain.turns,
    activeTurns: domain.activeTurns,
    entries: domain.entries,
    deletedEntries: domain.deletedEntries,
  }, usage);
  const publicEvent: RelayAgentAuthorityPublicEvent = deepFreeze({
    ...state.binding,
    agentEventSeq: nextAgentEventSeq,
    eventId,
    occurredAtMs: event.occurredAtMs,
    mutation: domain.publicMutation!,
  });
  return result(nextState, "applied", { publicEvent });
}
