import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize } from "node:path";
import type {
  CanonicalAgentMessageResult,
  CanonicalTerminalOwner,
} from "../../canonicalTerminalControlClient.js";
import {
  RPC_V2_CAPABILITIES,
  parseRpcV2CreateResponse,
  parseRpcV2CreateResolvedWorktreeRequest,
  parseRpcV2CreateTerminalRequest,
  parseRpcV2CreateWorktreeRequest,
  parseRpcV2KillSessionRequest,
  parseRpcV2KillSessionResponse,
  type RpcV2CreateTerminalRequest,
  type RpcV2CreateResolvedWorktreeRequest,
  type RpcV2CreateWorktreeRequest,
  type RpcV2Session,
} from "../../rpcV2.js";
import type { ManagedSessionReservationCorrelationV1 } from "../../state.js";
import {
  issueRelayV2CanonicalBackendInstanceKey,
} from "./canonicalBackendIdentity.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
  RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
  RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
  type RelayV2CanonicalBackendOutcome,
  type RelayV2CanonicalCommandExecutor,
  type RelayV2CanonicalCommandRequest,
  type RelayV2CommandAdmission,
  type RelayV2CommandAuthorityEvidence,
  type RelayV2CommandOperation,
  type RelayV2CommandRequestFingerprint,
  type RelayV2CommandResolutionFence,
  type RelayV2CommandResolutionTransaction,
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
import type { RelayV2TerminalCanonicalTargetBindingV1 } from "./terminalManager.js";

export const RELAY_V2_CANONICAL_ADAPTER_STATE_SCHEMA_VERSION = 2 as const;
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
      execution: RpcV2CreateResolvedWorktreeRequest["execution"];
      publicDisplayName: string;
      prospectiveSession: RelayV2CanonicalProspectiveSession;
    }
  | {
      authority: "tw_rpc";
      operation: "create_terminal";
      processTarget: RelayV2CanonicalProcessTarget;
      capabilities: readonly string[];
      arguments: RpcV2CreateTerminalRequest["arguments"];
      execution: {
        canonicalCwd: string;
        publicDisplayName: string;
      };
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
      targetBinding: RelayV2TerminalCanonicalTargetBindingV1;
    };

export type RelayV2CanonicalTargetResolution =
  | {
      kind: "resolved";
      coverage: "complete";
      evidence: RelayV2CanonicalResolverEvidence;
      target: RelayV2CanonicalResolvedTarget;
      admissionFence: RelayV2JsonObject;
    }
  | {
      kind: "not_found";
      coverage: "complete";
      evidence: RelayV2CanonicalResolverEvidence;
      code: "SCOPE_NOT_FOUND" | "PROJECT_NOT_FOUND" | "SESSION_NOT_FOUND" | "PANE_NOT_FOUND";
      admissionFence: RelayV2JsonObject;
    }
  | {
      kind: "not_found";
      coverage: "partial" | "unreachable";
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
 * is permitted while satisfying this port. fenceResolution must synchronously
 * bind the full target carried in the command fence to its own authority proof;
 * when it delegates an embedded H2 resource cut, it must first bind the outer
 * process target, capabilities, managed incarnation, and overlapping IDs to
 * that exact cut. For terminal control this also includes the exact target and
 * control-target identity owned by the terminal resolver. Resolution must not
 * acquire a terminal lease; that side effect belongs exclusively to the
 * execution port after H1 has durably committed RUNNING.
 */
export interface RelayV2CanonicalTargetResolverPort {
  resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CanonicalTargetResolution>;
  fenceResolution(
    transaction: RelayV2CommandResolutionTransaction,
    request: RelayV2CanonicalCommandRequest,
    fence: RelayV2CommandResolutionFence,
  ): void;
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

export interface RelayV2CanonicalTerminalControlExecutionPort {
  executeAgentMessage(input: {
    targetBinding: RelayV2TerminalCanonicalTargetBindingV1;
    owner: CanonicalTerminalOwner & { kind: "relay-v2" };
    operationId: string;
    pane: string;
    message: string;
    submit: boolean;
  }): Promise<RelayV2CanonicalTerminalControlResult>;
}

export interface RelayV2CanonicalCommandExecutorAdapterOptions {
  resolver: RelayV2CanonicalTargetResolverPort;
  process: RelayV2StructuredProcessPort;
  terminalControl: RelayV2CanonicalTerminalControlExecutionPort;
  terminalOwner: CanonicalTerminalOwner & { kind: "relay-v2" };
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

function isThenable(value: unknown): boolean {
  try {
    const thenable = ((typeof value === "object" && value !== null)
      || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function";
    if (thenable) void Promise.resolve(value).catch(() => undefined);
    return thenable;
  } catch {
    return true;
  }
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

function terminalOperationId(plan: RelayV2TerminalControlExecutionPlan): string {
  const operationId = domainHash("twmsg2", "tmux-worktree.relay-v2.agent-message.v1", {
    hostEpoch: plan.hostEpoch,
    principalId: plan.principalId,
    hostId: plan.hostId,
    commandId: plan.commandId,
    requestFingerprint: fingerprint(plan.requestFingerprint),
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

function notFoundCodeAllowed(
  request: RelayV2CanonicalCommandRequest,
  code: unknown,
): boolean {
  if (code === "SCOPE_NOT_FOUND") return true;
  if (code === "PROJECT_NOT_FOUND") {
    return request.operation === "create_worktree"
      && !Object.hasOwn(request.arguments, "path");
  }
  if (code === "SESSION_NOT_FOUND") {
    return request.operation === "send_agent_message" || request.operation === "kill_session";
  }
  return code === "PANE_NOT_FOUND" && request.operation === "send_agent_message";
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

function acceptedCreateArguments(
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
    if (canonicalJson(resolved) !== canonicalJson(accepted)) {
      throw new TypeError("canonical resolver changed accepted create-worktree arguments");
    }
    return accepted;
  }
  const accepted = parseRpcV2CreateTerminalRequest({
    arguments: request.arguments,
    reservationCorrelation: probeCorrelation,
  }).arguments;
  const resolved = parseRpcV2CreateTerminalRequest({
    arguments: value,
    reservationCorrelation: probeCorrelation,
  }).arguments;
  if (canonicalJson(resolved) !== canonicalJson(accepted)) {
    throw new TypeError("canonical resolver changed accepted create-terminal arguments");
  }
  return accepted;
}

function terminalExecution(
  value: unknown,
  accepted: RpcV2CreateTerminalRequest["arguments"],
): {
  canonicalCwd: string;
  publicDisplayName: string;
} {
  if (!isRecord(value)
    || !exactKeys(value, ["canonicalCwd", "publicDisplayName"])) {
    throw new TypeError("canonical terminal execution target is malformed");
  }
  const canonicalCwd = boundedString(value.canonicalCwd, 4_096);
  if (!isAbsolute(canonicalCwd) || normalize(canonicalCwd) !== canonicalCwd) {
    throw new TypeError("canonical terminal cwd is not a normalized absolute path");
  }
  const publicDisplayName = boundedString(value.publicDisplayName);
  const derivedDisplayName = (accepted.label ?? basename(canonicalCwd)) || "Terminal";
  if (publicDisplayName !== derivedDisplayName) {
    throw new TypeError("canonical terminal display is not derived from its frozen cwd");
  }
  return {
    canonicalCwd,
    publicDisplayName,
  };
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

function terminalTargetBinding(
  value: unknown,
  request: RelayV2CanonicalCommandRequest,
): RelayV2TerminalCanonicalTargetBindingV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])
    || value.schemaVersion !== 1
    || value.hostId !== request.hostId
    || value.scopeId !== request.scopeId
    || value.sessionId !== request.sessionId
    || value.pane !== request.arguments.pane
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.exactControlIdentity.schemaVersion !== 1) {
    throw new TypeError("canonical terminal-control target binding is malformed");
  }
  return {
    schemaVersion: 1,
    hostId: request.hostId,
    scopeId: request.scopeId,
    sessionId: boundedString(value.sessionId),
    pane: safeInteger(value.pane),
    processTarget: {
      kind: value.processTarget.kind,
      targetId: boundedString(value.processTarget.targetId),
    },
    backendInstanceKey: boundedString(value.backendInstanceKey),
    managedTarget: managedTarget(value.managedTarget),
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: boundedString(value.exactControlIdentity.controlTargetId),
      controlEpoch: boundedString(value.exactControlIdentity.controlEpoch),
      targetIncarnationProof: boundedString(
        value.exactControlIdentity.targetIncarnationProof,
      ),
    },
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
      "execution", "publicDisplayName", "prospectiveSession",
    ])) {
      throw new TypeError("canonical create target is malformed");
    }
    const args = acceptedCreateArguments(request.operation, value.arguments, request);
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
      const execution = parseRpcV2CreateResolvedWorktreeRequest({
        arguments: worktreeArgs,
        execution: value.execution,
        reservationCorrelation: correlation(request, "resolver-reservation"),
      }).execution;
      if (displayName !== execution.publicDisplayName
        || session.displayName !== displayName
        || session.project !== execution.effectiveProject
        || session.cwd !== execution.worktreePath) {
        throw new TypeError("canonical worktree display evidence is not bound to accepted arguments");
      }
      return {
        ...base,
        operation: request.operation,
        arguments: worktreeArgs,
        execution,
      };
    }
    const terminalArgs = args as RpcV2CreateTerminalRequest["arguments"];
    const execution = terminalExecution(value.execution, terminalArgs);
    if (displayName !== execution.publicDisplayName
      || (terminalArgs.label !== undefined && displayName !== terminalArgs.label)
      || session.displayName !== displayName
      || session.label !== displayName
      || session.cwd !== execution.canonicalCwd) {
      throw new TypeError("canonical terminal display evidence is not bound to accepted arguments");
    }
    return {
      ...base,
      operation: request.operation,
      arguments: terminalArgs,
      execution,
    };
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
  if (!exactKeys(value, ["authority", "operation", "targetBinding"])) {
    throw new TypeError("canonical terminal-control target is malformed");
  }
  return {
    authority: "terminal_control",
    operation: request.operation,
    targetBinding: terminalTargetBinding(value.targetBinding, request),
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

function rpcOperation(
  operation: RelayV2CommandOperation,
): "create-worktree-resolved" | "create-terminal" | "kill-session" {
  if (operation === "create_worktree") return "create-worktree-resolved";
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
      displayName: session.label,
      state: "running",
      project: session.project,
      label: session.kind === "terminal" ? session.label : null,
      cwd: session.cwd,
      attached: session.attached,
      windowCount: session.windows,
      createdAtMs: Date.parse(session.createdAt),
      activityAtMs,
    },
  } as RelayV2JsonObject;
  if ((session.kind === "worktree" && (session.project === null || session.label === null))
    || (session.kind === "terminal" && (session.project !== null || session.label === null))
    || session.kind !== (target.operation === "create_worktree" ? "worktree" : "terminal")
    || session.label !== target.publicDisplayName
    || (target.operation === "create_worktree" && (
      session.name !== target.execution.rawSessionName
      || session.project !== target.execution.effectiveProject
      || session.repoPath !== target.execution.canonicalRepoPath
      || session.worktreePath === null
      || session.worktreePath !== target.execution.worktreePath
      || session.branch === null
      || session.branch !== target.execution.worktreeBranch
      || session.baseBranch !== target.execution.effectiveBaseBranch
      || session.cwd !== session.worktreePath
    ))
    || (target.operation === "create_terminal" && (
      session.project !== null
      || session.repoPath !== null
      || session.worktreePath !== null
      || session.branch !== null
      || session.baseBranch !== null
      || session.cwd !== target.execution.canonicalCwd
    ))) {
    throw new TypeError("canonical RPC v2 Session kind fields are inconsistent");
  }
  return {
    schemaVersion: RELAY_V2_COMMAND_BACKEND_OUTCOME_SCHEMA_VERSION,
    backendInstanceKey: issueRelayV2CanonicalBackendInstanceKey({
      processTarget: {
        kind: target.processTarget.kind,
        targetId: target.processTarget.targetId,
      },
      incarnation: session.incarnation,
    }),
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
    targetBinding: RelayV2TerminalCanonicalTargetBindingV1;
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
    && value.controlEpoch === input.targetBinding.exactControlIdentity.controlEpoch
    && typeof value.fence === "string"
    && /^(?:0|[1-9][0-9]*)$/.test(value.fence)
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
  private readonly terminalControl: RelayV2CanonicalTerminalControlExecutionPort;
  private readonly terminalOwner: CanonicalTerminalOwner & { kind: "relay-v2" };

  constructor(options: RelayV2CanonicalCommandExecutorAdapterOptions) {
    if (!isRecord(options)
      || !isRecord(options.resolver)
      || typeof options.resolver.resolve !== "function"
      || typeof options.resolver.fenceResolution !== "function"
      || !isRecord(options.process)
      || typeof options.process.execute !== "function"
      || !isRecord(options.terminalControl)
      || typeof options.terminalControl.executeAgentMessage !== "function"
      || !isRecord(options.terminalOwner)
      || !exactKeys(options.terminalOwner, ["kind", "instanceId"])
      || options.terminalOwner.kind !== "relay-v2") {
      throw new TypeError("Relay v2 canonical executor ports are invalid");
    }
    this.resolver = options.resolver;
    this.process = options.process;
    this.terminalControl = options.terminalControl;
    this.terminalOwner = Object.freeze({
      kind: "relay-v2",
      instanceId: boundedString(options.terminalOwner.instanceId, 256),
    });
  }

  async resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CommandAdmission> {
    let raw: unknown;
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

    if (!isRecord(raw)) {
      return {
        kind: "transient_admission_failure",
        error: transientError("INTERNAL", "Canonical target evidence is invalid"),
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
      const coverage = (raw.coverage === "complete"
        || raw.coverage === "partial"
        || raw.coverage === "unreachable")
        ? raw.coverage as "complete" | "partial" | "unreachable"
        : null;
      const expectedKeys = coverage === "complete"
        ? ["kind", "coverage", "evidence", "code", "admissionFence"]
        : ["kind", "coverage", "evidence", "code"];
      if (!exactKeys(raw, expectedKeys)
        || coverage === null
        || (coverage === "complete" && !isRecord(raw.admissionFence))
        || !notFoundCodeAllowed(request, raw.code)) {
        return {
          kind: "transient_admission_failure",
          authorityEvidence: authorityEvidence(
            request,
            coverage ?? "unreachable",
            evidence,
          ),
          error: transientError("INTERNAL", "Canonical target evidence is invalid"),
        };
      }
      const observed = authorityEvidence(request, coverage, evidence);
      if (coverage !== "complete") {
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
        resolutionFence: {
          schemaVersion: RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
          outcome: "complete_negative",
          authority: request.authority,
          operation: request.operation,
          expectedScopeId: request.scopeId,
          expectedSessionId: request.sessionId,
          code: raw.code as string,
          evidence: clone(raw.admissionFence) as RelayV2JsonObject,
        },
        error: {
          code: raw.code as string,
          message: "Canonical target does not exist in the complete authority view",
          retryable: false,
          commandDisposition: "completed",
          details: null,
        },
      };
    }
    if (raw.kind === "unavailable") {
      const validCoverage = raw.coverage === "partial" || raw.coverage === "unreachable";
      const validCode = raw.code === "SCOPE_UNREACHABLE"
        || raw.code === "BUSY"
        || raw.code === "CAPABILITY_UNAVAILABLE";
      const hasRetryAfterMs = Object.hasOwn(raw, "retryAfterMs");
      let retryAfterMs: number | null | undefined = undefined;
      try {
        if (!exactKeys(
          raw,
          hasRetryAfterMs
            ? ["kind", "coverage", "evidence", "code", "retryAfterMs"]
            : ["kind", "coverage", "evidence", "code"],
        ) || !validCoverage || !validCode) {
          throw new TypeError("canonical unavailable evidence is malformed");
        }
        retryAfterMs = hasRetryAfterMs
          ? raw.retryAfterMs === null
            ? null
            : safeInteger(raw.retryAfterMs)
          : undefined;
      } catch {
        return {
          kind: "transient_admission_failure",
          authorityEvidence: authorityEvidence(
            request,
            validCoverage ? raw.coverage as "partial" | "unreachable" : "unreachable",
            evidence,
          ),
          error: transientError("INTERNAL", "Canonical target evidence is invalid"),
        };
      }
      return {
        kind: "transient_admission_failure",
        authorityEvidence: authorityEvidence(
          request,
          raw.coverage as "partial" | "unreachable",
          evidence,
        ),
        error: transientError(
          raw.code as string,
          "Canonical target authority is incomplete or unreachable",
          retryAfterMs,
        ),
      };
    }

    if (raw.kind !== "resolved") {
      return {
        kind: "transient_admission_failure",
        error: transientError("INTERNAL", "Canonical target evidence is invalid"),
      };
    }
    if (!exactKeys(raw, ["kind", "coverage", "evidence", "target", "admissionFence"])
      || !isRecord(raw.admissionFence)
      || raw.coverage !== "complete") {
      const coverage = raw.coverage === "partial" || raw.coverage === "unreachable"
        ? raw.coverage
        : "unreachable";
      return {
        kind: "transient_admission_failure",
        authorityEvidence: authorityEvidence(request, coverage, evidence),
        error: transientError("INTERNAL", "Canonical target evidence is invalid"),
      };
    }

    try {
      const target = resolvedTarget(raw.target, request);
      const state = adapterState(request, evidence, target);
      if (target.operation === "create_worktree" || target.operation === "create_terminal") {
        const session = clone(target.prospectiveSession) as unknown as RelayV2JsonObject;
        return {
          kind: "executable",
          adapterState: state as unknown as RelayV2JsonObject,
          resolutionFence: {
            schemaVersion: RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
            outcome: "positive",
            authority: request.authority,
            operation: request.operation,
            expectedScopeId: request.scopeId,
            expectedSessionId: request.sessionId,
            target: clone(target) as unknown as RelayV2JsonObject,
            evidence: clone(raw.admissionFence) as RelayV2JsonObject,
          },
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
        resolutionFence: {
          schemaVersion: RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION,
          outcome: "positive",
          authority: request.authority,
          operation: request.operation,
          expectedScopeId: request.scopeId,
          expectedSessionId: request.sessionId,
          target: clone(target) as unknown as RelayV2JsonObject,
          evidence: clone(raw.admissionFence) as RelayV2JsonObject,
        },
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

  fenceResolution(
    transaction: RelayV2CommandResolutionTransaction,
    request: RelayV2CanonicalCommandRequest,
    fence: RelayV2CommandResolutionFence,
  ): void {
    if (transaction.hostEpoch !== request.hostEpoch
      || fence.schemaVersion !== RELAY_V2_COMMAND_RESOLUTION_FENCE_SCHEMA_VERSION
      || fence.authority !== request.authority
      || fence.operation !== request.operation
      || fence.expectedScopeId !== request.scopeId
      || fence.expectedSessionId !== request.sessionId
      || !isRecord(fence.evidence)) {
      throw new TypeError("canonical resolution fence crossed command authority");
    }
    if (fence.outcome === "positive") {
      const target = resolvedTarget(fence.target, request);
      if (canonicalJson(target) !== canonicalJson(fence.target)) {
        throw new TypeError("canonical resolution fence target is inexact");
      }
    } else if (!notFoundCodeAllowed(request, fence.code)) {
      throw new TypeError("canonical negative resolution fence is inexact");
    }
    const fenced = this.resolver.fenceResolution(
      transaction,
      clone(request),
      clone(fence),
    );
    if (isThenable(fenced)) {
      throw new TypeError("canonical target resolver fence must be synchronous");
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
        if (plan.operation === "create_worktree") {
          if (target.operation !== "create_worktree") return { state: "in_doubt" };
          request = parseRpcV2CreateResolvedWorktreeRequest({
            arguments: target.arguments,
            execution: target.execution,
            reservationCorrelation: expectedCorrelation,
          }) as unknown as RelayV2JsonObject;
        } else {
          if (target.operation !== "create_terminal") return { state: "in_doubt" };
          request = parseRpcV2CreateTerminalRequest({
            arguments: {
              cwd: target.execution.canonicalCwd,
              label: target.execution.publicDisplayName,
            },
            reservationCorrelation: expectedCorrelation,
          }) as unknown as RelayV2JsonObject;
        }
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
            backendInstanceKey: issueRelayV2CanonicalBackendInstanceKey({
              processTarget: {
                kind: target.processTarget.kind,
                targetId: target.processTarget.targetId,
              },
              incarnation: response.incarnation,
            }),
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
        plan.operation === "create_worktree" ? "create-worktree-resolved" : "create-terminal",
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
        targetBinding: clone(state.target.targetBinding),
        owner: { ...this.terminalOwner },
        operationId,
        pane: String(state.target.targetBinding.pane),
        message: plan.arguments.message as string,
        submit: plan.arguments.submit as boolean,
      };
      let response: RelayV2CanonicalTerminalControlResult;
      try {
        response = await this.terminalControl.executeAgentMessage(input);
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
