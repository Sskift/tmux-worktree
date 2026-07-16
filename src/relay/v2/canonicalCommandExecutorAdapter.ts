import { createHash } from "node:crypto";
import type {
  CanonicalAgentMessageResult,
  CanonicalTerminalLease,
} from "../../canonicalTerminalControlClient.js";
import {
  RPC_V2_CAPABILITIES,
  parseRpcV2CreateResponse,
  parseRpcV2CreateTerminalRequest,
  parseRpcV2CreateWorktreeRequest,
  parseRpcV2KillSessionRequest,
  parseRpcV2KillSessionResponse,
  type RpcV2CreateTerminalRequest,
  type RpcV2CreateWorktreeRequest,
  type RpcV2Session,
} from "../../rpcV2.js";
import type { ManagedSessionReservationCorrelationV1 } from "../../state.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
  RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
  type RelayV2CanonicalBackendOutcome,
  type RelayV2CanonicalCommandExecutor,
  type RelayV2CanonicalCommandRequest,
  type RelayV2CommandAdmission,
  type RelayV2CommandAuthorityEvidence,
  type RelayV2CommandOperation,
  type RelayV2CommandRequestFingerprint,
  type RelayV2CommandStructuredError,
  type RelayV2TerminalControlExecutionOutcome,
  type RelayV2TerminalControlExecutionPlan,
  type RelayV2TwRpcExecutionOutcome,
  type RelayV2TwRpcExecutionPlan,
} from "./hostCommandPlane.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
} from "./strictJson.js";

export const RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_CANONICAL_PROCESS_STDOUT_BYTES = 1_048_576;
export const RELAY_V2_CANONICAL_PROCESS_STDERR_BYTES = 65_536;
export const RELAY_V2_CANONICAL_RPC_FRAME_BYTES = 1_048_575;
export const RELAY_V2_CANONICAL_ADAPTER_STATE_BYTES = 65_536;
export const RELAY_V2_CANONICAL_CREATE_WORKTREE_TIMEOUT_MS = 120_000;
export const RELAY_V2_CANONICAL_MUTATION_TIMEOUT_MS = 30_000;

const RPC_JSON_LIMITS = {
  maxDepth: 16,
  maxDirectKeys: 256,
  maxTotalKeys: 1_024,
  maxNodes: 4_096,
} as const;

export interface RelayV2CanonicalResolverEvidence {
  /** Non-sensitive identifier of the injected canonical authority cut. */
  authorityId: string;
  revision: string;
  observedAtMs: number;
}

export type RelayV2CanonicalProcessTarget =
  | { kind: "local"; scopeId: string; targetId: string }
  | { kind: "ssh"; scopeId: string; targetId: string };

export interface RelayV2CanonicalProspectiveSession {
  kind: "worktree" | "terminal";
  displayName: string;
  state: "running";
  project: string | null;
  label: string | null;
  cwd: string;
  attached: boolean;
  windowCount: number;
  createdAtMs: number;
  activityAtMs: number;
}

export type RelayV2CanonicalResolvedTarget =
  | {
      authority: "tw_rpc";
      operation: "create_worktree";
      processTarget: RelayV2CanonicalProcessTarget;
      capabilities: readonly string[];
      arguments: RpcV2CreateWorktreeRequest["arguments"];
      publicDisplayName: string;
      prospectiveSession: RelayV2CanonicalProspectiveSession;
    }
  | {
      authority: "tw_rpc";
      operation: "create_terminal";
      processTarget: RelayV2CanonicalProcessTarget;
      capabilities: readonly string[];
      arguments: RpcV2CreateTerminalRequest["arguments"];
      publicDisplayName: string;
      prospectiveSession: RelayV2CanonicalProspectiveSession;
    }
  | {
      authority: "tw_rpc";
      operation: "kill_session";
      processTarget: RelayV2CanonicalProcessTarget;
      capabilities: readonly string[];
      managedTarget: {
        name: string;
        kind: "worktree" | "terminal";
        incarnation: string;
      };
    }
  | {
      authority: "terminal_control";
      operation: "send_agent_message";
      scopeId: string;
      pane: string;
      lease: CanonicalTerminalLease;
    };

export type RelayV2CanonicalTargetResolution =
  | {
      kind: "resolved";
      coverage: "complete";
      evidence: RelayV2CanonicalResolverEvidence;
      target: RelayV2CanonicalResolvedTarget;
    }
  | {
      kind: "not_found";
      coverage: "complete" | "partial" | "unreachable";
      evidence: RelayV2CanonicalResolverEvidence;
      code: "SCOPE_NOT_FOUND" | "PROJECT_NOT_FOUND" | "SESSION_NOT_FOUND" | "PANE_NOT_FOUND";
    }
  | {
      kind: "unavailable";
      coverage: "partial" | "unreachable";
      evidence: RelayV2CanonicalResolverEvidence;
      code: "SCOPE_UNREACHABLE" | "BUSY" | "CAPABILITY_UNAVAILABLE";
      retryAfterMs?: number | null;
    };

/**
 * The resolver is the only source of target truth. It must be side-effect free:
 * no discovery scan, lease acquisition, name fallback, or public ID allocation
 * is permitted while satisfying this port.
 */
export interface RelayV2CanonicalTargetResolverPort {
  resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CanonicalTargetResolution>;
}

export interface RelayV2StructuredProcessRequest {
  target: RelayV2CanonicalProcessTarget;
  executable: "tw";
  argv: readonly string[];
  stdin: null;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxResponseFrameBytes: number;
}

export type RelayV2StructuredProcessResult =
  | {
      kind: "exited";
      exitCode: number;
      signal: string | null;
      stdout: Uint8Array;
      stderr: Uint8Array;
      elapsedMs: number;
    }
  | {
      kind: "timed_out" | "spawn_failed";
      stdout: Uint8Array;
      stderr: Uint8Array;
      elapsedMs: number;
    };

export interface RelayV2StructuredProcessPort {
  execute(request: RelayV2StructuredProcessRequest): Promise<RelayV2StructuredProcessResult>;
}

export type RelayV2CanonicalTerminalControlResult =
  | { state: "succeeded"; result: CanonicalAgentMessageResult }
  | {
      state: "failed";
      sideEffect: "not_applied";
      error: { code: string; message: string };
    }
  | { state: "ambiguous" | "in_doubt" };

export interface RelayV2CanonicalTerminalControlPort {
  sendAgentMessage(input: {
    scopeId: string;
    lease: CanonicalTerminalLease;
    operationId: string;
    pane: string;
    message: string;
    submit: boolean;
  }): Promise<RelayV2CanonicalTerminalControlResult>;
}

export interface RelayV2CanonicalCommandExecutorAdapterOptions {
  resolver: RelayV2CanonicalTargetResolverPort;
  process: RelayV2StructuredProcessPort;
  terminalControl: RelayV2CanonicalTerminalControlPort;
}

interface StoredAdapterState {
  schemaVersion: typeof RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  evidence: RelayV2CanonicalResolverEvidence;
  target: RelayV2CanonicalResolvedTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError("canonical adapter received an invalid bounded identifier");
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("canonical adapter received an invalid non-negative integer");
  }
  return value as number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function domainHash(prefix: string, domain: string, value: Record<string, unknown>): string {
  const digest = createHash("sha256").update(canonicalJson({ domain, value }), "utf8").digest("base64url");
  return `${prefix}.${digest}`;
}

function backendInstanceKey(
  target: RelayV2CanonicalProcessTarget,
  incarnation: string,
): string {
  return domainHash("twbk2", "tmux-worktree.relay-v2.backend-instance.v1", {
    processTarget: { kind: target.kind, targetId: target.targetId },
    rpcIncarnation: incarnation,
  });
}

function terminalOperationId(plan: RelayV2TerminalControlExecutionPlan): string {
  const operationId = domainHash("twmsg2", "tmux-worktree.relay-v2.agent-message.v1", {
    hostEpoch: plan.hostEpoch,
    principalId: plan.principalId,
    hostId: plan.hostId,
    commandId: plan.commandId,
  });
  if (Buffer.byteLength(operationId, "utf8") > 192) {
    throw new TypeError("canonical terminal-control operation identity exceeds its hard limit");
  }
  return operationId;
}

function fingerprint(value: unknown): RelayV2CommandRequestFingerprint {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "algorithm", "digest"])
    || value.schemaVersion !== 1
    || value.algorithm !== "sha256-rfc8785"
    || typeof value.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new TypeError("canonical adapter received an invalid command fingerprint");
  }
  return clone(value) as unknown as RelayV2CommandRequestFingerprint;
}

function resolverEvidence(value: unknown): RelayV2CanonicalResolverEvidence {
  if (!isRecord(value)
    || !exactKeys(value, ["authorityId", "revision", "observedAtMs"])) {
    throw new TypeError("canonical resolver evidence is malformed");
  }
  return {
    authorityId: boundedString(value.authorityId),
    revision: boundedString(value.revision),
    observedAtMs: safeInteger(value.observedAtMs),
  };
}

function processTarget(value: unknown, scopeId: string): RelayV2CanonicalProcessTarget {
  if (!isRecord(value)
    || !exactKeys(value, ["kind", "scopeId", "targetId"])
    || (value.kind !== "local" && value.kind !== "ssh")
    || value.scopeId !== scopeId) {
    throw new TypeError("canonical process target is malformed");
  }
  return {
    kind: value.kind,
    scopeId,
    targetId: boundedString(value.targetId),
  };
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length > 64
    || value.some((item) => typeof item !== "string"
      || item.length === 0
      || item.trim() !== item
      || item.includes("\0")
      || Buffer.byteLength(item, "utf8") > 128)
    || new Set(value).size !== value.length) {
    throw new TypeError("canonical RPC v2 capability evidence is malformed");
  }
  const advertised = new Set(value as string[]);
  if (RPC_V2_CAPABILITIES.some((required) => !advertised.has(required))) {
    throw new TypeError("canonical RPC v2 capability evidence is incomplete");
  }
  return [...value] as string[];
}

function prospectiveSession(
  value: unknown,
  operation: "create_worktree" | "create_terminal",
): RelayV2CanonicalProspectiveSession {
  if (!isRecord(value) || !exactKeys(value, [
    "kind", "displayName", "state", "project", "label", "cwd", "attached",
    "windowCount", "createdAtMs", "activityAtMs",
  ])
    || value.kind !== (operation === "create_worktree" ? "worktree" : "terminal")
    || value.state !== "running"
    || typeof value.attached !== "boolean"
    || (value.project !== null && typeof value.project !== "string")
    || (value.label !== null && typeof value.label !== "string")) {
    throw new TypeError("canonical prospective Session is malformed");
  }
  const session: RelayV2CanonicalProspectiveSession = {
    kind: value.kind as "worktree" | "terminal",
    displayName: boundedString(value.displayName),
    state: "running",
    project: value.project === null ? null : boundedString(value.project),
    label: value.label === null ? null : boundedString(value.label),
    cwd: boundedString(value.cwd, 4_096),
    attached: value.attached,
    windowCount: safeInteger(value.windowCount),
    createdAtMs: safeInteger(value.createdAtMs),
    activityAtMs: safeInteger(value.activityAtMs),
  };
  if ((session.kind === "worktree" && (session.project === null || session.label !== null))
    || (session.kind === "terminal" && (session.project !== null || session.label === null))) {
    throw new TypeError("canonical prospective Session fields do not match its kind");
  }
  return session;
}

function correlation(
  request: Pick<RelayV2CanonicalCommandRequest,
    "commandId" | "hostEpoch" | "principalId" | "hostId" | "requestFingerprint">,
  reservationId: string,
): ManagedSessionReservationCorrelationV1 {
  return {
    schemaVersion: 1,
    reservationId: boundedString(reservationId),
    hostEpoch: boundedString(request.hostEpoch),
    principalId: boundedString(request.principalId),
    hostId: boundedString(request.hostId),
    commandId: boundedString(request.commandId),
    requestFingerprint: fingerprint(request.requestFingerprint),
  };
}

function createArguments(
  operation: "create_worktree" | "create_terminal",
  value: unknown,
  request: RelayV2CanonicalCommandRequest,
): RpcV2CreateWorktreeRequest["arguments"] | RpcV2CreateTerminalRequest["arguments"] {
  const probeCorrelation = correlation(request, "resolver-reservation");
  if (operation === "create_worktree") {
    const accepted = parseRpcV2CreateWorktreeRequest({
      arguments: request.arguments,
      reservationCorrelation: probeCorrelation,
    }).arguments;
    const resolved = parseRpcV2CreateWorktreeRequest({
        arguments: value,
        reservationCorrelation: probeCorrelation,
      }).arguments;
    if (resolved.aiCommand !== accepted.aiCommand
      || (accepted.project !== undefined && resolved.project !== accepted.project)
      || (accepted.name !== undefined && resolved.name !== accepted.name)
      || resolved.project === undefined
      || resolved.path === undefined
      || resolved.name === undefined
      || Object.hasOwn(resolved, "branch") !== Object.hasOwn(accepted, "branch")
      || resolved.branch !== accepted.branch) {
      throw new TypeError("canonical resolver changed accepted create-worktree arguments");
    }
    return resolved;
  }
  const accepted = parseRpcV2CreateTerminalRequest({
    arguments: request.arguments,
    reservationCorrelation: probeCorrelation,
  }).arguments;
  const resolved = parseRpcV2CreateTerminalRequest({
    arguments: value,
    reservationCorrelation: probeCorrelation,
  }).arguments;
  if ((accepted.label !== undefined && resolved.label !== accepted.label)
    || resolved.label === undefined) {
    throw new TypeError("canonical resolver changed accepted create-terminal arguments");
  }
  return resolved;
}

function managedTarget(value: unknown): {
  name: string;
  kind: "worktree" | "terminal";
  incarnation: string;
} {
  if (!isRecord(value)
    || !exactKeys(value, ["name", "kind", "incarnation"])
    || (value.kind !== "worktree" && value.kind !== "terminal")) {
    throw new TypeError("canonical managed target is malformed");
  }
  const incarnation = boundedString(value.incarnation);
  if (!/^twinc2\.[A-Za-z0-9_-]{43}$/.test(incarnation)) {
    throw new TypeError("canonical managed target incarnation is malformed");
  }
  return {
    name: boundedString(value.name),
    kind: value.kind,
    incarnation,
  };
}

function terminalLease(value: unknown): CanonicalTerminalLease {
  if (!isRecord(value)
    || !exactKeys(value, [
      "controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt",
    ])
    || !isRecord(value.owner)
    || !exactKeys(value.owner, ["kind", "instanceId"])
    || value.owner.kind !== "relay-v2") {
    throw new TypeError("canonical terminal-control lease is malformed");
  }
  const expiresAt = boundedString(value.expiresAt, 64);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || new Date(expiresAtMs).toISOString() !== expiresAt) {
    throw new TypeError("canonical terminal-control lease expiry is malformed");
  }
  const fence = boundedString(value.fence, 64);
  if (!/^(?:0|[1-9][0-9]*)$/.test(fence)) {
    throw new TypeError("canonical terminal-control fence is malformed");
  }
  return {
    controlTargetId: boundedString(value.controlTargetId, 1_024),
    controlEpoch: boundedString(value.controlEpoch, 1_024),
    leaseId: boundedString(value.leaseId, 1_024),
    fence,
    owner: {
      kind: "relay-v2",
      instanceId: boundedString(value.owner.instanceId, 1_024),
    },
    expiresAt,
  };
}

function resolvedTarget(
  value: unknown,
  request: RelayV2CanonicalCommandRequest,
): RelayV2CanonicalResolvedTarget {
  if (!isRecord(value)
    || value.authority !== request.authority
    || value.operation !== request.operation) {
    throw new TypeError("canonical resolver target does not match the command");
  }
  if (request.operation === "create_worktree" || request.operation === "create_terminal") {
    if (!exactKeys(value, [
      "authority", "operation", "processTarget", "capabilities", "arguments",
      "publicDisplayName", "prospectiveSession",
    ])) {
      throw new TypeError("canonical create target is malformed");
    }
    const args = createArguments(request.operation, value.arguments, request);
    const displayName = boundedString(value.publicDisplayName);
    const session = prospectiveSession(value.prospectiveSession, request.operation);
    const base = {
      authority: "tw_rpc" as const,
      processTarget: processTarget(value.processTarget, request.scopeId),
      capabilities: capabilities(value.capabilities),
      publicDisplayName: displayName,
      prospectiveSession: session,
    };
    if (request.operation === "create_worktree") {
      const worktreeArgs = args as RpcV2CreateWorktreeRequest["arguments"];
      if (displayName !== worktreeArgs.name
        || session.displayName !== displayName
        || session.project !== worktreeArgs.project) {
        throw new TypeError("canonical worktree display evidence is not bound to accepted arguments");
      }
      return { ...base, operation: request.operation, arguments: worktreeArgs };
    }
    const terminalArgs = args as RpcV2CreateTerminalRequest["arguments"];
    if (displayName !== terminalArgs.label
      || session.displayName !== displayName
      || session.label !== displayName
      || session.cwd !== terminalArgs.cwd) {
      throw new TypeError("canonical terminal display evidence is not bound to accepted arguments");
    }
    return { ...base, operation: request.operation, arguments: terminalArgs };
  }
  if (request.operation === "kill_session") {
    if (!exactKeys(value, [
      "authority", "operation", "processTarget", "capabilities", "managedTarget",
    ])) {
      throw new TypeError("canonical kill target is malformed");
    }
    return {
      authority: "tw_rpc",
      operation: request.operation,
      processTarget: processTarget(value.processTarget, request.scopeId),
      capabilities: capabilities(value.capabilities),
      managedTarget: managedTarget(value.managedTarget),
    };
  }
  if (!exactKeys(value, ["authority", "operation", "scopeId", "pane", "lease"])
    || value.scopeId !== request.scopeId
    || value.pane !== String(request.arguments.pane)) {
    throw new TypeError("canonical terminal-control target is malformed");
  }
  return {
    authority: "terminal_control",
    operation: request.operation,
    scopeId: request.scopeId,
    pane: boundedString(value.pane, 16),
    lease: terminalLease(value.lease),
  };
}

function authorityEvidence(
  request: RelayV2CanonicalCommandRequest,
  coverage: "complete" | "partial" | "unreachable",
  evidence: RelayV2CanonicalResolverEvidence,
): RelayV2CommandAuthorityEvidence {
  return {
    schemaVersion: RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
    coverage,
    authority: request.authority,
    hostId: request.hostId,
    hostEpoch: request.hostEpoch,
    scopeId: request.scopeId,
    sessionId: request.sessionId,
    evidence: clone(evidence) as unknown as RelayV2JsonObject,
  };
}

function transientError(
  code: string,
  message: string,
  retryAfterMs?: number | null,
): RelayV2CommandStructuredError {
  return {
    code,
    message,
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    commandDisposition: "not_accepted",
    details: null,
  };
}

function finalFailure(message: string): RelayV2CommandStructuredError {
  return {
    code: "COMMAND_FAILED",
    message,
    retryable: false,
    commandDisposition: "completed",
    details: null,
  };
}

function adapterState(
  request: RelayV2CanonicalCommandRequest,
  evidence: RelayV2CanonicalResolverEvidence,
  target: RelayV2CanonicalResolvedTarget,
): StoredAdapterState {
  const state: StoredAdapterState = {
    schemaVersion: RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION,
    commandId: boundedString(request.commandId),
    requestFingerprint: fingerprint(request.requestFingerprint),
    evidence: clone(evidence),
    target: clone(target),
  };
  if (Buffer.byteLength(canonicalJson(state), "utf8") > RELAY_V2_CANONICAL_ADAPTER_STATE_BYTES) {
    throw new TypeError("canonical adapter state exceeds its hard limit");
  }
  return state;
}

function parseAdapterState(
  value: unknown,
  plan: RelayV2TwRpcExecutionPlan | RelayV2TerminalControlExecutionPlan,
): StoredAdapterState {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "commandId", "requestFingerprint", "evidence", "target"])
    || value.schemaVersion !== RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION) {
    throw new TypeError("canonical adapter state is malformed");
  }
  const request: RelayV2CanonicalCommandRequest = {
    fingerprintSchemaVersion: 1,
    commandId: boundedString(plan.commandId),
    requestFingerprint: fingerprint(plan.requestFingerprint),
    authority: plan.authority,
    operation: plan.operation,
    principalId: plan.principalId,
    hostId: plan.hostId,
    hostEpoch: plan.hostEpoch,
    scopeId: plan.scopeId,
    sessionId: plan.sessionId,
    arguments: clone(plan.arguments),
  };
  const storedCommandId = boundedString(value.commandId);
  const storedFingerprint = fingerprint(value.requestFingerprint);
  if (storedCommandId !== request.commandId
    || canonicalJson(storedFingerprint) !== canonicalJson(request.requestFingerprint)) {
    throw new TypeError("canonical adapter state identity does not match its execution plan");
  }
  const state: StoredAdapterState = {
    schemaVersion: RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION,
    commandId: request.commandId,
    requestFingerprint: request.requestFingerprint,
    evidence: resolverEvidence(value.evidence),
    target: resolvedTarget(value.target, request),
  };
  if (Buffer.byteLength(canonicalJson(state), "utf8") > RELAY_V2_CANONICAL_ADAPTER_STATE_BYTES) {
    throw new TypeError("canonical adapter state exceeds its hard limit");
  }
  return state;
}

function rpcOperation(operation: RelayV2CommandOperation): "create-worktree" | "create-terminal" | "kill-session" {
  if (operation === "create_worktree") return "create-worktree";
  if (operation === "create_terminal") return "create-terminal";
  return "kill-session";
}

function timeoutFor(operation: RelayV2TwRpcExecutionPlan["operation"]): number {
  return operation === "create_worktree"
    ? RELAY_V2_CANONICAL_CREATE_WORKTREE_TIMEOUT_MS
    : RELAY_V2_CANONICAL_MUTATION_TIMEOUT_MS;
}

function processRequest(
  target: RelayV2CanonicalProcessTarget,
  operation: RelayV2TwRpcExecutionPlan["operation"],
  request: RelayV2JsonObject,
): RelayV2StructuredProcessRequest {
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson, "utf8") > RELAY_V2_CANONICAL_RPC_FRAME_BYTES) {
    throw new TypeError("canonical RPC v2 request exceeds its hard frame limit");
  }
  return Object.freeze({
    target: clone(target),
    executable: "tw" as const,
    argv: Object.freeze(["rpc-v2", rpcOperation(operation), "--request-json", requestJson]),
    stdin: null,
    timeoutMs: timeoutFor(operation),
    maxStdoutBytes: RELAY_V2_CANONICAL_PROCESS_STDOUT_BYTES,
    maxStderrBytes: RELAY_V2_CANONICAL_PROCESS_STDERR_BYTES,
    maxResponseFrameBytes: RELAY_V2_CANONICAL_RPC_FRAME_BYTES,
  });
}

function parseProcessFrame(result: RelayV2StructuredProcessResult, timeoutMs: number): RelayV2JsonObject {
  if (!isRecord(result)
    || result.kind !== "exited"
    || !Number.isSafeInteger(result.exitCode)
    || result.exitCode !== 0
    || result.signal !== null
    || !(result.stdout instanceof Uint8Array)
    || !(result.stderr instanceof Uint8Array)
    || !Number.isSafeInteger(result.elapsedMs)
    || result.elapsedMs < 0
    || result.elapsedMs > timeoutMs
    || result.stdout.byteLength > RELAY_V2_CANONICAL_PROCESS_STDOUT_BYTES
    || result.stderr.byteLength > RELAY_V2_CANONICAL_PROCESS_STDERR_BYTES
    || result.stdout.byteLength < 2
    || result.stdout[result.stdout.byteLength - 1] !== 0x0a) {
    throw new TypeError("canonical RPC v2 process result is uncertain");
  }
  const frameBytes = result.stdout.subarray(0, result.stdout.byteLength - 1);
  if (frameBytes.byteLength > RELAY_V2_CANONICAL_RPC_FRAME_BYTES
    || frameBytes.includes(0x0a)
    || frameBytes.includes(0x0d)) {
    throw new TypeError("canonical RPC v2 stdout is not exactly one JSON line");
  }
  const source = decodeRelayV2StrictUtf8(frameBytes);
  return parseRelayV2JsonObject(source, RPC_JSON_LIMITS) as RelayV2JsonObject;
}

function sessionEvidence(
  session: RpcV2Session,
  target: Extract<RelayV2CanonicalResolvedTarget, {
    operation: "create_worktree" | "create_terminal";
  }>,
): RelayV2CanonicalBackendOutcome {
  const activityAtMs = session.activity * 1_000;
  if (!Number.isSafeInteger(activityAtMs)) {
    throw new TypeError("canonical RPC v2 Session activity exceeds the safe time range");
  }
  const evidence = {
    session: {
      kind: session.kind,
      displayName: target.publicDisplayName,
      state: "running",
      project: session.project,
      label: session.kind === "terminal" ? target.publicDisplayName : null,
      cwd: session.cwd,
      attached: session.attached,
      windowCount: session.windows,
      createdAtMs: Date.parse(session.createdAt),
      activityAtMs,
    },
  } as RelayV2JsonObject;
  if ((session.kind === "worktree" && (session.project === null || session.label !== null))
    || (session.kind === "terminal" && (session.project !== null || session.label === null))
    || session.kind !== (target.operation === "create_worktree" ? "worktree" : "terminal")
    || (target.operation === "create_worktree"
      && session.project !== target.prospectiveSession.project)
    || (target.operation === "create_terminal" && (
      session.label !== target.publicDisplayName || session.cwd !== target.arguments.cwd
    ))) {
    throw new TypeError("canonical RPC v2 Session kind fields are inconsistent");
  }
  return {
    schemaVersion: RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
    backendInstanceKey: backendInstanceKey(target.processTarget, session.incarnation),
    evidence,
  };
}

function sameCorrelation(
  left: ManagedSessionReservationCorrelationV1 | null,
  right: ManagedSessionReservationCorrelationV1,
): boolean {
  return left !== null && canonicalJson(left) === canonicalJson(right);
}

function validTerminalSuccess(
  value: unknown,
  input: {
    operationId: string;
    lease: CanonicalTerminalLease;
  },
): value is CanonicalAgentMessageResult {
  return isRecord(value)
    && exactKeys(value, [
      "operationId", "accepted", "deduplicated", "controlEpoch", "fence",
      "outputGeneration", "outputCursor",
    ])
    && value.operationId === input.operationId
    && value.accepted === true
    && typeof value.deduplicated === "boolean"
    && value.controlEpoch === input.lease.controlEpoch
    && value.fence === input.lease.fence
    && typeof value.outputGeneration === "string"
    && value.outputGeneration.length > 0
    && !value.outputGeneration.includes("\0")
    && Buffer.byteLength(value.outputGeneration, "utf8") <= 1_024
    && Number.isSafeInteger(value.outputCursor)
    && (value.outputCursor as number) >= 0;
}

/**
 * Unwired H1-A foundation. This adapter translates one immutable H1 plan into
 * exactly one canonical authority call. It owns no credential, public Session
 * identity, ledger, materialized resource, terminal lease, retry, or fallback.
 */
export class RelayV2CanonicalCommandExecutorAdapter implements RelayV2CanonicalCommandExecutor {
  private readonly resolver: RelayV2CanonicalTargetResolverPort;
  private readonly process: RelayV2StructuredProcessPort;
  private readonly terminalControl: RelayV2CanonicalTerminalControlPort;

  constructor(options: RelayV2CanonicalCommandExecutorAdapterOptions) {
    this.resolver = options.resolver;
    this.process = options.process;
    this.terminalControl = options.terminalControl;
  }

  async resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CommandAdmission> {
    let raw: RelayV2CanonicalTargetResolution;
    try {
      fingerprint(request.requestFingerprint);
      boundedString(request.commandId);
      raw = await this.resolver.resolve(clone(request));
    } catch {
      return {
        kind: "transient_admission_failure",
        error: transientError("INTERNAL", "Canonical target authority is unavailable"),
      };
    }

    let evidence: RelayV2CanonicalResolverEvidence;
    try {
      evidence = resolverEvidence(raw.evidence);
    } catch {
      return {
        kind: "transient_admission_failure",
        error: transientError("INTERNAL", "Canonical target evidence is invalid"),
      };
    }
    if (raw.kind === "not_found") {
      const observed = authorityEvidence(request, raw.coverage, evidence);
      if (raw.coverage !== "complete") {
        return {
          kind: "transient_admission_failure",
          authorityEvidence: observed,
          error: transientError(
            "SCOPE_UNREACHABLE",
            "Canonical target authority is incomplete or unreachable",
          ),
        };
      }
      return {
        kind: "immutable_business_failure",
        authorityEvidence: observed,
        error: {
          code: raw.code,
          message: "Canonical target does not exist in the complete authority view",
          retryable: false,
          commandDisposition: "completed",
          details: null,
        },
      };
    }
    if (raw.kind === "unavailable") {
      let retryAfterMs: number | null | undefined;
      try {
        retryAfterMs = raw.retryAfterMs === undefined || raw.retryAfterMs === null
          ? raw.retryAfterMs
          : safeInteger(raw.retryAfterMs);
      } catch {
        retryAfterMs = undefined;
      }
      return {
        kind: "transient_admission_failure",
        authorityEvidence: authorityEvidence(request, raw.coverage, evidence),
        error: transientError(
          raw.code,
          "Canonical target authority is incomplete or unreachable",
          retryAfterMs,
        ),
      };
    }

    try {
      if (raw.coverage !== "complete") throw new TypeError("resolved target lacks complete coverage");
      const target = resolvedTarget(raw.target, request);
      const state = adapterState(request, evidence, target);
      if (target.operation === "create_worktree" || target.operation === "create_terminal") {
        const session = clone(target.prospectiveSession) as unknown as RelayV2JsonObject;
        return {
          kind: "executable",
          adapterState: state as unknown as RelayV2JsonObject,
          resourceReservationPlan: {
            logicalTarget: {
              operation: target.operation,
              scopeId: request.scopeId,
              arguments: clone(target.arguments) as unknown as RelayV2JsonObject,
            },
            session,
          },
        };
      }
      return {
        kind: "executable",
        adapterState: state as unknown as RelayV2JsonObject,
      };
    } catch (error) {
      const capability = error instanceof Error && error.message.includes("capability");
      return {
        kind: "transient_admission_failure",
        authorityEvidence: authorityEvidence(request, "complete", evidence),
        error: transientError(
          capability ? "CAPABILITY_UNAVAILABLE" : "INTERNAL",
          capability
            ? "Canonical RPC v2 capability is unavailable"
            : "Canonical target evidence is invalid",
        ),
      };
    }
  }

  async executeTwRpc(plan: RelayV2TwRpcExecutionPlan): Promise<RelayV2TwRpcExecutionOutcome> {
    try {
      const state = parseAdapterState(plan.adapterState, plan);
      if (state.target.authority !== "tw_rpc" || state.target.operation !== plan.operation) {
        return { state: "in_doubt" };
      }
      const target = state.target;
      let request: RelayV2JsonObject;
      let expectedCorrelation: ManagedSessionReservationCorrelationV1 | null = null;
      if (plan.operation === "create_worktree" || plan.operation === "create_terminal") {
        if (target.operation !== plan.operation || plan.resourceReservation === null) {
          return { state: "in_doubt" };
        }
        expectedCorrelation = correlation({
          commandId: plan.commandId,
          requestFingerprint: plan.requestFingerprint,
          hostEpoch: plan.hostEpoch,
          principalId: plan.principalId,
          hostId: plan.hostId,
        }, plan.resourceReservation.reservationId);
        request = plan.operation === "create_worktree"
          ? parseRpcV2CreateWorktreeRequest({
              arguments: target.arguments,
              reservationCorrelation: expectedCorrelation,
            }) as unknown as RelayV2JsonObject
          : parseRpcV2CreateTerminalRequest({
              arguments: target.arguments,
              reservationCorrelation: expectedCorrelation,
            }) as unknown as RelayV2JsonObject;
      } else {
        if (target.operation !== "kill_session" || plan.resourceReservation !== null) {
          return { state: "in_doubt" };
        }
        request = parseRpcV2KillSessionRequest({
          name: target.managedTarget.name,
          expectedIncarnation: target.managedTarget.incarnation,
        }) as unknown as RelayV2JsonObject;
      }

      const invocation = processRequest(target.processTarget, plan.operation, request);
      let raw: RelayV2StructuredProcessResult;
      try {
        raw = await this.process.execute(invocation);
      } catch {
        return { state: "in_doubt" };
      }
      let frame: RelayV2JsonObject;
      try {
        frame = parseProcessFrame(raw, invocation.timeoutMs);
      } catch {
        return { state: "in_doubt" };
      }

      if (plan.operation === "kill_session") {
        const response = parseRpcV2KillSessionResponse(frame);
        if (response.state === "in_doubt") return { state: "in_doubt" };
        if (response.state === "failed") {
          return {
            state: "failed",
            sideEffect: "not_applied",
            error: finalFailure("Canonical TW RPC proved the kill was not applied"),
          };
        }
        if (target.operation !== "kill_session"
          || response.name !== target.managedTarget.name
          || response.kind !== target.managedTarget.kind
          || response.incarnation !== target.managedTarget.incarnation) {
          return { state: "in_doubt" };
        }
        return {
          state: "succeeded",
          backendOutcome: {
            schemaVersion: RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
            backendInstanceKey: backendInstanceKey(target.processTarget, response.incarnation),
            evidence: { terminated: true },
          },
          commitIntent: {
            operation: plan.operation,
            expectedIncarnation: response.incarnation,
          },
        };
      }

      if (target.operation !== "create_worktree" && target.operation !== "create_terminal") {
        return { state: "in_doubt" };
      }
      const response = parseRpcV2CreateResponse(
        frame,
        plan.operation === "create_worktree" ? "create-worktree" : "create-terminal",
      );
      if (response.state === "in_doubt") return { state: "in_doubt" };
      if (response.state === "failed") {
        return {
          state: "failed",
          sideEffect: "not_applied",
          error: finalFailure("Canonical TW RPC proved the create was not applied"),
        };
      }
      if (expectedCorrelation === null
        || !sameCorrelation(response.session.reservationCorrelation, expectedCorrelation)) {
        return { state: "in_doubt" };
      }
      const backendOutcome = sessionEvidence(response.session, target);
      return {
        state: "succeeded",
        backendOutcome,
        commitIntent: {
          operation: plan.operation,
          scopeId: plan.scopeId,
          backendInstanceKey: backendOutcome.backendInstanceKey,
        },
      };
    } catch {
      return { state: "in_doubt" };
    }
  }

  async executeTerminalControl(
    plan: RelayV2TerminalControlExecutionPlan,
  ): Promise<RelayV2TerminalControlExecutionOutcome> {
    try {
      const state = parseAdapterState(plan.adapterState, plan);
      if (state.target.authority !== "terminal_control"
        || state.target.operation !== "send_agent_message") {
        return { state: "in_doubt" };
      }
      const operationId = terminalOperationId(plan);
      const input = {
        scopeId: plan.scopeId,
        lease: clone(state.target.lease),
        operationId,
        pane: state.target.pane,
        message: plan.arguments.message as string,
        submit: plan.arguments.submit as boolean,
      };
      let response: RelayV2CanonicalTerminalControlResult;
      try {
        response = await this.terminalControl.sendAgentMessage(input);
      } catch {
        return { state: "in_doubt" };
      }
      if (response.state === "ambiguous" || response.state === "in_doubt") {
        return { state: "in_doubt" };
      }
      if (response.state === "failed") {
        if (!isRecord(response)
          || !exactKeys(response, ["state", "sideEffect", "error"])
          || response.sideEffect !== "not_applied"
          || !isRecord(response.error)
          || !exactKeys(response.error, ["code", "message"])
          || typeof response.error.code !== "string"
          || response.error.code.length === 0
          || response.error.code.includes("\0")
          || Buffer.byteLength(response.error.code, "utf8") > 128
          || typeof response.error.message !== "string"
          || response.error.message.length === 0
          || response.error.message.includes("\0")
          || Buffer.byteLength(response.error.message, "utf8") > 4_096) {
          return { state: "in_doubt" };
        }
        return {
          state: "failed",
          sideEffect: "not_applied",
          error: finalFailure("Canonical terminal-control proved the input was not applied"),
        };
      }
      if (response.state !== "succeeded") return { state: "in_doubt" };
      if (!validTerminalSuccess(response.result, input)) {
        return { state: "in_doubt" };
      }
      return {
        state: "succeeded",
        result: {
          pane: plan.arguments.pane,
          submit: plan.arguments.submit,
          messageUtf8Bytes: Buffer.byteLength(plan.arguments.message as string, "utf8"),
        },
      };
    } catch {
      return { state: "in_doubt" };
    }
  }
}
