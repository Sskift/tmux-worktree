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
  RelayV2ResourceResolverScopeEvidence,
  RelayV2ResourceResolverSessionEvidence,
} from "./resourceState.js";
import { RELAY_V2_RESOURCE_RESOLVER_CUT } from "./resourceState.js";

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
 * and JSON-line I/O; this adapter never consumes raw process output. Once the
 * signal is aborted, query() must settle only after its child/transport/stdio
 * resource barrier has settled. A non-settling port intentionally keeps the
 * discovery scan fail-closed rather than allowing a later scan to overlap it.
 */
export interface RelayV2CanonicalTwRpcDiscoveryQueryPort {
  query(request: RelayV2CanonicalTwRpcDiscoveryQuery): Promise<unknown>;
}

export interface RelayV2CanonicalTwRpcDiscoveryAdapterOptions {
  scopes: readonly RelayV2CanonicalTwRpcDiscoveryScope[];
  queryPort: RelayV2CanonicalTwRpcDiscoveryQueryPort;
  queryTimeoutMs?: number;
}

interface NormalizedDiscoveryConfiguration {
  revision: string;
  scopes: readonly RelayV2CanonicalTwRpcDiscoveryScope[];
  queryPort: RelayV2CanonicalTwRpcDiscoveryQueryPort;
  queryTimeoutMs: number;
}

interface ScannedScope {
  publicScope: RelayV2DiscoveredScope;
  scopeTarget: RelayV2ResourceResolverScopeEvidence | null;
  sessionTargets: RelayV2ResourceResolverSessionEvidence[];
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
  | { kind: "aborted" }
  | { kind: "transport_error" };

interface DiscoveryScanFlight {
  configuration: NormalizedDiscoveryConfiguration;
  controller: AbortController;
  promise: Promise<RelayV2ResourceDiscoveryScan>;
}

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

function normalizeConfiguration(
  options: RelayV2CanonicalTwRpcDiscoveryAdapterOptions,
  revision: string,
): NormalizedDiscoveryConfiguration {
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
  return {
    revision,
    scopes: normalizeScopes(options.scopes),
    queryPort: options.queryPort,
    queryTimeoutMs,
  };
}

export class RelayV2CanonicalTwRpcDiscoveryAdapter implements RelayV2ResourceDiscovery {
  private configuration: NormalizedDiscoveryConfiguration;

  private configurationRevision = 1;

  private scanRevision = 0;

  private completedWinner: object | null = null;

  private scanInFlight: DiscoveryScanFlight | null = null;

  private reconfigurationBarrier: Promise<void> | null = null;

  private configurationWithdrawn = false;

  constructor(options: RelayV2CanonicalTwRpcDiscoveryAdapterOptions) {
    this.configuration = normalizeConfiguration(options, "1");
  }

  /** Atomically swaps one already-explicit scope/query-target configuration. */
  reconfigure(options: RelayV2CanonicalTwRpcDiscoveryAdapterOptions): void {
    if (this.reconfigurationBarrier !== null) {
      throw new TypeError("canonical TW RPC v2 discovery reconfiguration is already active");
    }
    const nextRevision = this.configurationRevision + 1;
    const next = normalizeConfiguration(options, String(nextRevision));
    this.configurationRevision = nextRevision;
    this.configuration = next;
    this.configurationWithdrawn = false;
    this.completedWinner = null;
    this.scanInFlight?.controller.abort();
  }

  /**
   * Retires the old scan through its transport barrier before a synchronous
   * caller-owned target authority swap. New scans wait behind the same gate.
   */
  async reconfigureAfterRetirement(
    options: RelayV2CanonicalTwRpcDiscoveryAdapterOptions,
    replaceTargetAuthority: () => void,
  ): Promise<void> {
    if (this.reconfigurationBarrier !== null || typeof replaceTargetAuthority !== "function") {
      throw new TypeError("canonical TW RPC v2 discovery reconfiguration is already active");
    }
    const nextRevision = this.configurationRevision + 1;
    const next = normalizeConfiguration(options, String(nextRevision));
    const retired = this.scanInFlight?.promise ?? Promise.resolve();
    let releaseGate: (() => void) | undefined;
    let rejectGate: ((error: unknown) => void) | undefined;
    const gate = new Promise<void>((resolve, reject) => {
      releaseGate = resolve;
      rejectGate = reject;
    });
    void gate.catch(() => {});
    this.reconfigurationBarrier = gate;
    this.configurationRevision = nextRevision;
    this.configuration = next;
    this.configurationWithdrawn = false;
    this.completedWinner = null;
    this.scanInFlight?.controller.abort();
    try {
      await retired.catch(() => {});
      const result = (replaceTargetAuthority as () => unknown)();
      if (result !== null && typeof result === "object"
        && typeof (result as { then?: unknown }).then === "function") {
        throw new TypeError("canonical target authority replacement must be synchronous");
      }
      releaseGate?.();
    } catch (error) {
      rejectGate?.(error);
      throw error;
    } finally {
      if (this.reconfigurationBarrier === gate) this.reconfigurationBarrier = null;
    }
  }

  /** Withdraws config authority without manufacturing complete-empty deletion authority. */
  async withdrawAfterRetirement(): Promise<void> {
    if (this.reconfigurationBarrier !== null) {
      throw new TypeError("canonical TW RPC v2 discovery reconfiguration is already active");
    }
    const retired = this.scanInFlight?.promise ?? Promise.resolve();
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    this.reconfigurationBarrier = gate;
    this.configurationRevision += 1;
    this.configuration = {
      ...this.configuration,
      revision: String(this.configurationRevision),
    };
    this.configurationWithdrawn = true;
    this.completedWinner = null;
    this.scanInFlight?.controller.abort();
    try {
      await retired.catch(() => {});
      releaseGate?.();
    } finally {
      if (this.reconfigurationBarrier === gate) this.reconfigurationBarrier = null;
    }
  }

  scan(): Promise<RelayV2ResourceDiscoveryScan> {
    if (this.reconfigurationBarrier !== null) {
      return this.reconfigurationBarrier.then(() => this.scan());
    }
    if (this.configurationWithdrawn) {
      return Promise.resolve({ coverage: "partial", scopes: [] });
    }
    const configuration = this.configuration;
    const active = this.scanInFlight;
    if (active !== null) {
      if (active.configuration === configuration) return active.promise;
      return active.promise.then(
        () => this.scan(),
        () => this.scan(),
      );
    }
    const controller = new AbortController();
    const scanMarker = {
      configuration,
      generation: `${configuration.revision}.${++this.scanRevision}`,
    };
    const promise = Promise.resolve().then(() => (
      this.runScan(configuration, scanMarker, controller.signal)
    ));
    const flight: DiscoveryScanFlight = { configuration, controller, promise };
    this.scanInFlight = flight;
    void promise.finally(() => {
      if (this.scanInFlight === flight) this.scanInFlight = null;
    }).catch(() => {});
    return promise;
  }

  private async runScan(
    configuration: NormalizedDiscoveryConfiguration,
    scanMarker: { configuration: NormalizedDiscoveryConfiguration; generation: string },
    signal: AbortSignal,
  ): Promise<RelayV2ResourceDiscoveryScan> {
    // H2's full cut always spends one scope and one sessions_scope record per
    // configured scope. Sorted sequential scans keep both the query boundary
    // and the projected aggregate within the one shared record budget.
    const fixedRecordCount = configuration.scopes.length
      * RELAY_V2_CANONICAL_TW_RPC_DISCOVERY_FIXED_RECORDS_PER_SCOPE;
    let remainingSessionRecords = RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords
      - fixedRecordCount;
    const scopes: RelayV2DiscoveredScope[] = [];
    const scopeTargets: RelayV2ResourceResolverScopeEvidence[] = [];
    const sessionTargets: RelayV2ResourceResolverSessionEvidence[] = [];
    let aborted = false;
    for (const scope of configuration.scopes) {
      if (signal.aborted || this.configuration !== configuration) {
        aborted = true;
        break;
      }
      const scanned = await this.scanScope(
        configuration,
        scope,
        remainingSessionRecords,
        signal,
      );
      if (scanned === null) {
        aborted = true;
        break;
      }
      scopes.push(scanned.publicScope);
      if (scanned.scopeTarget !== null) scopeTargets.push(scanned.scopeTarget);
      sessionTargets.push(...scanned.sessionTargets);
      if (scanned.publicScope.sessionsCompleteness === "complete") {
        remainingSessionRecords -= scanned.publicScope.sessions.length;
      }
    }
    const result: RelayV2ResourceDiscoveryScan = {
      coverage: !aborted && scopes.length === configuration.scopes.length
        && scopes.every((scope) => scope.sessionsCompleteness === "complete")
        ? "complete"
        : "partial",
      scopes,
    };
    if (!aborted && this.configuration === configuration) {
      this.completedWinner = scanMarker;
    }
    Object.defineProperty(result, RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: Object.freeze({
        generation: scanMarker.generation,
        scopeTargets: Object.freeze(scopeTargets),
        sessionTargets: Object.freeze(sessionTargets),
        isCurrent: () => (
          this.configuration === configuration && this.completedWinner === scanMarker
        ),
      }),
      enumerable: false,
    });
    return result;
  }

  private async scanScope(
    configuration: NormalizedDiscoveryConfiguration,
    scope: RelayV2CanonicalTwRpcDiscoveryScope,
    maxSessions: number,
    signal: AbortSignal,
  ): Promise<ScannedScope | null> {
    const capabilitiesResult = await this.query(
      configuration,
      scope,
      "capabilities",
      signal,
    );
    if (capabilitiesResult.kind === "aborted") return null;
    if (capabilitiesResult.kind === "timed_out") {
      return {
        publicScope: failedScope(scope, TIMEOUT_ERROR, "unreachable"),
        scopeTarget: null,
        sessionTargets: [],
      };
    }
    if (capabilitiesResult.kind === "transport_error") {
      return {
        publicScope: failedScope(scope, TRANSPORT_ERROR, "unreachable"),
        scopeTarget: null,
        sessionTargets: [],
      };
    }
    let capabilities: RpcV2CapabilitiesResponse;
    try {
      capabilities = parseCapabilitiesResponse(capabilitiesResult.value);
    } catch {
      return {
        publicScope: failedScope(scope, CAPABILITY_ERROR, "online"),
        scopeTarget: null,
        sessionTargets: [],
      };
    }

    const listResult = await this.query(configuration, scope, "list", signal, maxSessions);
    if (listResult.kind === "aborted") return null;
    if (listResult.kind === "timed_out") {
      return {
        publicScope: failedScope(scope, TIMEOUT_ERROR, "unreachable"),
        scopeTarget: null,
        sessionTargets: [],
      };
    }
    if (listResult.kind === "transport_error") {
      return {
        publicScope: failedScope(scope, TRANSPORT_ERROR, "unreachable"),
        scopeTarget: null,
        sessionTargets: [],
      };
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
        publicScope: {
          backendIdentity: scope.backendIdentity,
          displayName: scope.displayName,
          kind: scope.kind,
          reachability: "online",
          sessionsCompleteness: "complete",
          sessions,
          error: null,
          reservationCorrelationCompleteness: "complete",
        },
        scopeTarget: {
          scopeBackendIdentity: scope.backendIdentity,
          processTarget: { ...scope.processTarget },
          capabilities: [...capabilities.capabilities],
        },
        sessionTargets: response.sessions.map((session) => ({
          scopeBackendIdentity: scope.backendIdentity,
          sessionBackendIdentity: issueRelayV2CanonicalBackendInstanceKey({
            processTarget: scope.processTarget,
            incarnation: session.incarnation,
          }),
          backendKind: session.kind,
          processTarget: { ...scope.processTarget },
          capabilities: [...capabilities.capabilities],
          managedTarget: {
            name: session.name,
            kind: session.kind,
            incarnation: session.incarnation,
          },
        })),
      };
    } catch {
      return {
        publicScope: failedScope(scope, MALFORMED_RESPONSE_ERROR, "online"),
        scopeTarget: null,
        sessionTargets: [],
      };
    }
  }

  private async query(
    configuration: NormalizedDiscoveryConfiguration,
    scope: RelayV2CanonicalTwRpcDiscoveryScope,
    command: RelayV2CanonicalTwRpcDiscoveryCommand,
    scanSignal: AbortSignal,
    maxSessions?: number,
  ): Promise<QueryResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const abortForScan = () => controller.abort();
    scanSignal.addEventListener("abort", abortForScan, { once: true });
    if (scanSignal.aborted) controller.abort();
    try {
      const request: RelayV2CanonicalTwRpcDiscoveryQuery = command === "capabilities"
        ? {
          processTarget: { ...scope.processTarget },
          command,
          timeoutMs: configuration.queryTimeoutMs,
          signal: controller.signal,
        }
        : {
          processTarget: { ...scope.processTarget },
          command,
          maxSessions: maxSessions as number,
          timeoutMs: configuration.queryTimeoutMs,
          signal: controller.signal,
        };
      const transport = Promise.resolve().then(() => (
        configuration.queryPort.query(request)
      )).then<QueryResult>(
        (value) => ({ kind: "succeeded", value }),
        () => ({ kind: "transport_error" }),
      );
      timer = setTimeout(() => {
        if (timedOut) return;
        timedOut = true;
        controller.abort();
      }, configuration.queryTimeoutMs);
      const result = await transport;
      if (scanSignal.aborted) return { kind: "aborted" };
      return timedOut ? { kind: "timed_out" } : result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      scanSignal.removeEventListener("abort", abortForScan);
    }
  }
}
