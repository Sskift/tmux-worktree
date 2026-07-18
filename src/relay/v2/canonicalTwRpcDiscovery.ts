import {
  RPC_V2_CAPABILITIES,
  type RpcV2CapabilitiesResponse,
  type RpcV2ListResponse,
  type RpcV2Session,
} from "../../rpcV2.js";
import { normalizeManagedSessionReservationCorrelation } from "../../state.js";
import {
  issueRelayV2CanonicalBackendInstanceKey,
} from "./canonicalBackendIdentity.js";
import { RELAY_V2_MATERIALIZED_CAPACITY } from "./resourceState.js";
import type {
  RelayV2DiscoveredSession,
  RelayV2DiscoveredReservationCorrelation,
  RelayV2DiscoveredScope,
  RelayV2DiscoveryError,
  RelayV2ResourceDiscovery,
  RelayV2ResourceDiscoveryScan,
} from "./resourceState.js";

const RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_FIXED_RECORDS_PER_SCOPE = 2;
export const RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES = Math.floor(
  RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords
    / RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_FIXED_RECORDS_PER_SCOPE,
);
export const RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SESSIONS_PER_SCOPE =
  RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords;
export const RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS = 5_000;

export type RelayV2CanonicalTwRpcDiscoveryCommand = "capabilities" | "list";

export interface RelayV2CanonicalTwRpcDiscoveryProcessTarget {
  kind: "local" | "ssh";
  targetId: string;
}

export interface RelayV2CanonicalTwRpcDiscoveryScope {
  backendIdentity: string;
  displayName: string;
  kind: "local" | "ssh";
  processTarget: RelayV2CanonicalTwRpcDiscoveryProcessTarget;
}

interface RelayV2CanonicalTwRpcDiscoveryQueryBase {
  processTarget: RelayV2CanonicalTwRpcDiscoveryProcessTarget;
  timeoutMs: number;
  signal: AbortSignal;
}

export type RelayV2CanonicalTwRpcDiscoveryQuery =
  | (RelayV2CanonicalTwRpcDiscoveryQueryBase & {
    command: "capabilities";
  })
  | (RelayV2CanonicalTwRpcDiscoveryQueryBase & {
    command: "list";
    maxSessions: number;
  });

/**
 * Typed boundary to canonical tw rpc-v2. Implementations own target resolution
 * and JSON-line I/O; this adapter never consumes raw process output.
 */
export interface RelayV2CanonicalTwRpcDiscoveryQueryPort {
  query(request: RelayV2CanonicalTwRpcDiscoveryQuery): Promise<unknown>;
}

export interface RelayV2CanonicalTwRpcDiscoveryAdapterOptions {
  scopes: readonly RelayV2CanonicalTwRpcDiscoveryScope[];
  queryPort: RelayV2CanonicalTwRpcDiscoveryQueryPort;
  queryTimeoutMs?: number;
}

export interface RelayV2CanonicalTwRpcDiscoveryInput {
  processTarget: {
    kind: "local" | "ssh";
    targetId: string;
  };
  session: RpcV2Session;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function persistedDisplayLabel(session: RpcV2Session): string {
  if (typeof session.label !== "string"
    || session.label.length === 0
    || session.label.trim() !== session.label
    || session.label.includes("\0")
    || Buffer.byteLength(session.label, "utf8") > 128) {
    throw new TypeError("canonical TW RPC Session lacks a persisted display label");
  }
  return session.label;
}

function sessionTimes(session: RpcV2Session): { createdAtMs: number; activityAtMs: number } {
  const createdAtMs = Date.parse(session.createdAt);
  const activityAtMs = session.activity * 1_000;
  if (!Number.isSafeInteger(createdAtMs)
    || !Number.isSafeInteger(activityAtMs)
    || createdAtMs < 0
    || activityAtMs < 0) {
    throw new TypeError("canonical TW RPC Session time evidence is invalid");
  }
  return { createdAtMs, activityAtMs };
}

/**
 * Canonical TW RPC discovery projection for the H2 discovery seam. It consumes
 * the persisted public label and shared backend identity owner; raw tmux names
 * and public Relay Session IDs never participate in either projection.
 */
export function projectRelayV2CanonicalTwRpcDiscoveredSession(
  input: RelayV2CanonicalTwRpcDiscoveryInput,
): RelayV2DiscoveredSession {
  const { session } = input;
  const displayName = persistedDisplayLabel(session);
  const times = sessionTimes(session);
  if (session.kind === "worktree") {
    if (session.project === null
      || session.repoPath === null
      || session.worktreePath === null
      || session.branch === null
      || session.baseBranch === null
      || session.cwd !== session.worktreePath) {
      throw new TypeError("canonical TW RPC worktree Session is incomplete");
    }
  } else if (session.project !== null
    || session.repoPath !== null
    || session.worktreePath !== null
    || session.branch !== null
    || session.baseBranch !== null) {
    throw new TypeError("canonical TW RPC terminal Session has worktree fields");
  }
  const reservationCorrelation = session.reservationCorrelation === null
    ? null
    : clone(session.reservationCorrelation) as RelayV2DiscoveredReservationCorrelation;
  return {
    backendIdentity: issueRelayV2CanonicalBackendInstanceKey({
      processTarget: input.processTarget,
      incarnation: session.incarnation,
    }),
    kind: session.kind,
    displayName,
    state: "running",
    project: session.project,
    label: session.kind === "terminal" ? displayName : null,
    cwd: session.cwd,
    attached: session.attached,
    windowCount: session.windows,
    ...times,
    ...(reservationCorrelation === null ? {} : { reservationCorrelation }),
  };
}

const CAPABILITY_ERROR: RelayV2DiscoveryError = Object.freeze({
  code: "CAPABILITY_UNAVAILABLE",
  message: "canonical TW RPC v2 capabilities are unavailable",
  retryable: false,
  commandDisposition: "not_applicable",
});

const MALFORMED_RESPONSE_ERROR: RelayV2DiscoveryError = Object.freeze({
  code: "INTERNAL",
  message: "canonical TW RPC v2 discovery response is malformed",
  retryable: false,
  commandDisposition: "not_applicable",
});

const TIMEOUT_ERROR: RelayV2DiscoveryError = Object.freeze({
  code: "SCOPE_UNREACHABLE",
  message: "canonical TW RPC v2 discovery timed out",
  retryable: true,
  commandDisposition: "not_applicable",
});

const TRANSPORT_ERROR: RelayV2DiscoveryError = Object.freeze({
  code: "SCOPE_UNREACHABLE",
  message: "canonical TW RPC v2 transport is unavailable",
  retryable: true,
  commandDisposition: "not_applicable",
});

type QueryResult =
  | { kind: "succeeded"; value: unknown }
  | { kind: "timed_out" }
  | { kind: "transport_error" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function nullableBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | null {
  return value === null ? null : boundedString(value, label, maxBytes);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`invalid ${label}`);
  }
  return value as number;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseCapabilitiesResponse(value: unknown): RpcV2CapabilitiesResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "app", "capabilities"])
    || value.protocolVersion !== 2
    || value.app !== "tmux-worktree"
    || !Array.isArray(value.capabilities)
    || value.capabilities.length > 64) {
    throw new TypeError("invalid canonical TW RPC v2 capabilities response");
  }
  const capabilities = value.capabilities.map((capability) => (
    boundedString(capability, "capability", 128)
  ));
  if (new Set(capabilities).size !== capabilities.length
    || RPC_V2_CAPABILITIES.some((capability) => !capabilities.includes(capability))) {
    throw new TypeError("incomplete canonical TW RPC v2 capabilities");
  }
  return {
    protocolVersion: 2,
    app: "tmux-worktree",
    capabilities,
  };
}

function parseSession(value: unknown): RpcV2Session {
  if (!isRecord(value) || !hasExactKeys(value, [
    "name",
    "kind",
    "profile",
    "project",
    "label",
    "repoPath",
    "worktreePath",
    "branch",
    "baseBranch",
    "cwd",
    "createdAt",
    "attached",
    "windows",
    "created",
    "activity",
    "incarnation",
    "lifecycleMarked",
    "reservationCorrelation",
  ])) {
    throw new TypeError("invalid canonical TW RPC v2 Session response");
  }
  if ((value.kind !== "worktree" && value.kind !== "terminal")
    || (value.profile !== "cli" && value.profile !== "dashboard")
    || typeof value.attached !== "boolean"
    || value.lifecycleMarked !== true) {
    throw new TypeError("invalid canonical TW RPC v2 Session response fields");
  }
  const createdAt = boundedString(value.createdAt, "createdAt", 64);
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs) || new Date(createdAtMs).toISOString() !== createdAt) {
    throw new TypeError("invalid canonical TW RPC v2 Session createdAt");
  }
  const incarnation = boundedString(value.incarnation, "incarnation", 128);
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(incarnation)) {
    throw new TypeError("invalid canonical TW RPC v2 Session incarnation");
  }
  return {
    name: boundedString(value.name, "name", 128),
    kind: value.kind,
    profile: value.profile,
    project: nullableBoundedString(value.project, "project", 128),
    label: nullableBoundedString(value.label, "label", 128),
    repoPath: nullableBoundedString(value.repoPath, "repoPath", 4_096),
    worktreePath: nullableBoundedString(value.worktreePath, "worktreePath", 4_096),
    branch: nullableBoundedString(value.branch, "branch", 255),
    baseBranch: nullableBoundedString(value.baseBranch, "baseBranch", 255),
    cwd: boundedString(value.cwd, "cwd", 4_096),
    createdAt,
    attached: value.attached,
    windows: nonNegativeSafeInteger(value.windows, "windows"),
    created: nonNegativeSafeInteger(value.created, "created"),
    activity: nonNegativeSafeInteger(value.activity, "activity"),
    incarnation,
    lifecycleMarked: true,
    reservationCorrelation: value.reservationCorrelation === null
      ? null
      : normalizeManagedSessionReservationCorrelation(value.reservationCorrelation),
  };
}

function parseListResponse(value: unknown, maxSessions: number): RpcV2ListResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocolVersion", "sessions"])
    || value.protocolVersion !== 2
    || !Array.isArray(value.sessions)
    || value.sessions.length > maxSessions
    || value.sessions.length > RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SESSIONS_PER_SCOPE) {
    throw new TypeError("invalid canonical TW RPC v2 list response");
  }
  return {
    protocolVersion: 2,
    sessions: value.sessions.map(parseSession),
  };
}

function normalizeProcessTarget(value: unknown): RelayV2CanonicalTwRpcDiscoveryProcessTarget {
  if (!isRecord(value)
    || !hasExactKeys(value, ["kind", "targetId"])
    || (value.kind !== "local" && value.kind !== "ssh")) {
    throw new TypeError("invalid canonical TW RPC v2 discovery process target");
  }
  return {
    kind: value.kind,
    targetId: boundedString(value.targetId, "process target ID", 128),
  };
}

function normalizeScopes(value: unknown): RelayV2CanonicalTwRpcDiscoveryScope[] {
  if (!Array.isArray(value)
    || value.length > RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_MAX_SCOPES) {
    throw new TypeError("invalid canonical TW RPC v2 discovery scopes");
  }
  const backendIdentities = new Set<string>();
  const processTargets = new Set<string>();
  const scopes = value.map((item) => {
    if (!isRecord(item)
      || !hasExactKeys(item, ["backendIdentity", "displayName", "kind", "processTarget"])
      || (item.kind !== "local" && item.kind !== "ssh")) {
      throw new TypeError("invalid canonical TW RPC v2 discovery scope");
    }
    const processTarget = normalizeProcessTarget(item.processTarget);
    if (item.kind !== processTarget.kind) {
      throw new TypeError("canonical TW RPC v2 discovery scope target kind mismatch");
    }
    const scope: RelayV2CanonicalTwRpcDiscoveryScope = {
      backendIdentity: boundedString(item.backendIdentity, "backend identity", 4_096),
      displayName: boundedString(item.displayName, "scope display name", 128),
      kind: item.kind,
      processTarget,
    };
    const processTargetKey = `${processTarget.kind}\0${processTarget.targetId}`;
    if (backendIdentities.has(scope.backendIdentity)) {
      throw new TypeError("duplicate canonical TW RPC v2 discovery backend identity");
    }
    if (processTargets.has(processTargetKey)) {
      throw new TypeError("duplicate canonical TW RPC v2 discovery process target");
    }
    backendIdentities.add(scope.backendIdentity);
    processTargets.add(processTargetKey);
    return scope;
  });
  return scopes.sort((left, right) => compareUtf8(left.backendIdentity, right.backendIdentity));
}

function failedScope(
  scope: RelayV2CanonicalTwRpcDiscoveryScope,
  error: RelayV2DiscoveryError,
  reachability: "online" | "unreachable",
): RelayV2DiscoveredScope {
  return {
    backendIdentity: scope.backendIdentity,
    displayName: scope.displayName,
    kind: scope.kind,
    reachability,
    sessionsCompleteness: "partial",
    sessions: [],
    error: { ...error },
    reservationCorrelationCompleteness: "unavailable",
  };
}

export class RelayV2CanonicalTwRpcDiscoveryAdapter implements RelayV2ResourceDiscovery {
  private readonly scopes: readonly RelayV2CanonicalTwRpcDiscoveryScope[];

  private readonly queryPort: RelayV2CanonicalTwRpcDiscoveryQueryPort;

  private readonly queryTimeoutMs: number;

  constructor(options: RelayV2CanonicalTwRpcDiscoveryAdapterOptions) {
    if (!isRecord(options)
      || !isRecord(options.queryPort)
      || typeof options.queryPort.query !== "function") {
      throw new TypeError("invalid canonical TW RPC v2 discovery adapter options");
    }
    const queryTimeoutMs = options.queryTimeoutMs
      ?? RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS;
    if (!Number.isSafeInteger(queryTimeoutMs)
      || queryTimeoutMs < 1
      || queryTimeoutMs > RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_QUERY_TIMEOUT_MS) {
      throw new TypeError("invalid canonical TW RPC v2 discovery query timeout");
    }
    this.scopes = normalizeScopes(options.scopes);
    this.queryPort = options.queryPort;
    this.queryTimeoutMs = queryTimeoutMs;
  }

  async scan(): Promise<RelayV2ResourceDiscoveryScan> {
    // H2's full cut always spends one scope and one sessions_scope record per
    // configured scope. Sorted sequential scans keep both the query boundary
    // and the projected aggregate within the one shared record budget.
    const fixedRecordCount = this.scopes.length
      * RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_FIXED_RECORDS_PER_SCOPE;
    let remainingSessionRecords = RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords
      - fixedRecordCount;
    const scopes: RelayV2DiscoveredScope[] = [];
    for (const scope of this.scopes) {
      const scanned = await this.scanScope(scope, remainingSessionRecords);
      scopes.push(scanned);
      if (scanned.sessionsCompleteness === "complete") {
        remainingSessionRecords -= scanned.sessions.length;
      }
    }
    return {
      coverage: scopes.every((scope) => scope.sessionsCompleteness === "complete")
        ? "complete"
        : "partial",
      scopes,
    };
  }

  private async scanScope(
    scope: RelayV2CanonicalTwRpcDiscoveryScope,
    maxSessions: number,
  ): Promise<RelayV2DiscoveredScope> {
    const capabilitiesResult = await this.query(scope, "capabilities");
    if (capabilitiesResult.kind === "timed_out") {
      return failedScope(scope, TIMEOUT_ERROR, "unreachable");
    }
    if (capabilitiesResult.kind === "transport_error") {
      return failedScope(scope, TRANSPORT_ERROR, "unreachable");
    }
    try {
      parseCapabilitiesResponse(capabilitiesResult.value);
    } catch {
      return failedScope(scope, CAPABILITY_ERROR, "online");
    }

    const listResult = await this.query(scope, "list", maxSessions);
    if (listResult.kind === "timed_out") {
      return failedScope(scope, TIMEOUT_ERROR, "unreachable");
    }
    if (listResult.kind === "transport_error") {
      return failedScope(scope, TRANSPORT_ERROR, "unreachable");
    }
    try {
      const response = parseListResponse(listResult.value, maxSessions);
      const sessions = response.sessions.map((session) => (
        projectRelayV2CanonicalTwRpcDiscoveredSession({
          processTarget: scope.processTarget,
          session,
        })
      )).sort((left, right) => (
        compareUtf8(left.kind, right.kind)
        || compareUtf8(left.backendIdentity, right.backendIdentity)
      ));
      for (let index = 1; index < sessions.length; index += 1) {
        const previous = sessions[index - 1];
        const current = sessions[index];
        if (previous.kind === current.kind
          && previous.backendIdentity === current.backendIdentity) {
          throw new TypeError("duplicate canonical TW RPC v2 Session authority identity");
        }
      }
      return {
        backendIdentity: scope.backendIdentity,
        displayName: scope.displayName,
        kind: scope.kind,
        reachability: "online",
        sessionsCompleteness: "complete",
        sessions,
        error: null,
        reservationCorrelationCompleteness: "complete",
      };
    } catch {
      return failedScope(scope, MALFORMED_RESPONSE_ERROR, "online");
    }
  }

  private async query(
    scope: RelayV2CanonicalTwRpcDiscoveryScope,
    command: RelayV2CanonicalTwRpcDiscoveryCommand,
    maxSessions?: number,
  ): Promise<QueryResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request: RelayV2CanonicalTwRpcDiscoveryQuery = command === "capabilities"
        ? {
          processTarget: { ...scope.processTarget },
          command,
          timeoutMs: this.queryTimeoutMs,
          signal: controller.signal,
        }
        : {
          processTarget: { ...scope.processTarget },
          command,
          maxSessions: maxSessions as number,
          timeoutMs: this.queryTimeoutMs,
          signal: controller.signal,
        };
      const transport = Promise.resolve().then(() => this.queryPort.query(request)).then<QueryResult>(
        (value) => ({ kind: "succeeded", value }),
        () => ({ kind: "transport_error" }),
      );
      const timeout = new Promise<QueryResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "timed_out" });
        }, this.queryTimeoutMs);
      });
      return await Promise.race([transport, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
