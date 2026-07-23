import type {
  CanonicalAgentMessageResult,
  CanonicalTerminalLease,
  CanonicalTerminalOwner,
} from "../../canonicalTerminalControlClient.js";
import {
  RPC_V2_CAPABILITIES,
  type RpcV2CreateResolvedWorktreeRequest,
  type RpcV2CreateTerminalRequest,
  type RpcV2CreateWorktreeRequest,
} from "../../rpcV2.js";
import {
  TERMINAL_CONTROL_MAX_INPUT_BYTES,
  TerminalControlProtocolError,
} from "../../terminalControl/protocol.js";
import type {
  RelayV2CanonicalProspectiveSession,
  RelayV2CanonicalResolvedTarget,
  RelayV2CanonicalResolverEvidence,
  RelayV2CanonicalTargetResolution,
  RelayV2CanonicalTargetResolverPort,
  RelayV2CanonicalTerminalControlResult,
  RelayV2CanonicalTerminalControlExecutionPort,
} from "./canonicalCommandExecutorAdapter.js";
import type {
  RelayV2ExactTerminalControlTargetEvidenceV1,
  RelayV2ExactTerminalControlTargetInputV1,
  RelayV2ExactTerminalControlTargetPortV1,
  RelayV2PreparedExactTerminalControlLeasePortV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import type {
  RelayV2CanonicalCommandRequest,
  RelayV2CommandResolutionFence,
  RelayV2CommandResolutionTransaction,
} from "./hostCommandPlane.js";
import type {
  RelayV2CanonicalResourceResolutionFence,
  RelayV2CanonicalResourceResolverPort,
  RelayV2CanonicalResourceResolverToken,
  RelayV2CanonicalResolvedScopeTarget,
  RelayV2CanonicalResolvedSessionTarget,
} from "./resourceState.js";
import type {
  RelayV2TerminalCanonicalTargetBindingV1,
} from "./terminalManager.js";
import type { RelayV2TerminalControlRequestPort } from "./terminalControlAuthorityAdapter.js";

export const RELAY_V2_CANONICAL_COMMAND_TARGET_AUTHORITY_SCHEMA_VERSION = 1 as const;

type CreateOperation = "create_worktree" | "create_terminal";

export interface RelayV2CanonicalCreateTargetAuthorityInputV1 {
  schemaVersion: 1;
  request: RelayV2CanonicalCommandRequest;
  resourceTarget: RelayV2CanonicalResolvedScopeTarget;
}

export type RelayV2CanonicalCreateTargetAuthorityEvidenceV1 =
  | {
      schemaVersion: 1;
      authorityToken: string;
      operation: "create_worktree";
      arguments: RpcV2CreateWorktreeRequest["arguments"];
      execution: RpcV2CreateResolvedWorktreeRequest["execution"];
      catalogRevision: string;
      publicDisplayName: string;
      prospectiveSession: RelayV2CanonicalProspectiveSession;
    }
  | {
      schemaVersion: 1;
      authorityToken: string;
      operation: "create_terminal";
      arguments: RpcV2CreateTerminalRequest["arguments"];
      execution: { canonicalCwd: string; publicDisplayName: string };
      catalogRevision: string;
      publicDisplayName: string;
      prospectiveSession: RelayV2CanonicalProspectiveSession;
    };

/**
 * The existing canonical catalog/placement owner supplies only create-specific
 * facts. H2 remains the sole source of scope process target and RPC capability
 * evidence. Omission is a closed, unavailable state; it never manufactures a
 * PROJECT_NOT_FOUND result.
 */
export interface RelayV2CanonicalCreateTargetAuthorityPortV1 {
  resolveCreateTarget(
    input: RelayV2CanonicalCreateTargetAuthorityInputV1,
  ): Promise<RelayV2CanonicalCreateTargetAuthorityEvidenceV1>;
  fenceCreateTargetForAdmission(
    input: RelayV2CanonicalCreateTargetAuthorityInputV1,
    evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
  ): void;
}

export interface RelayV2CanonicalCommandTargetAuthorityAdapterOptions {
  resourceResolver: RelayV2CanonicalResourceResolverPort;
  createTargetAuthority?: RelayV2CanonicalCreateTargetAuthorityPortV1;
  exactTerminalTarget?: RelayV2ExactTerminalControlTargetPortV1;
  now?: () => number;
}

type AdmissionEnvelope = {
  schemaVersion: 1;
  request: RelayV2CanonicalCommandRequest;
  resourceFence: RelayV2CanonicalResourceResolutionFence;
  commandProof:
    | { kind: "negative" }
    | { kind: "kill_session" }
    | {
        kind: "create";
        input: RelayV2CanonicalCreateTargetAuthorityInputV1;
        evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1;
      }
    | {
        kind: "terminal";
        input: RelayV2ExactTerminalControlTargetInputV1;
        evidence: RelayV2ExactTerminalControlTargetEvidenceV1;
      };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function bounded(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError("canonical target authority received an invalid identifier");
  }
  return value;
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

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Shared synchronous-fence guard; the create target admission module reuses it. */
export function requireSynchronous(value: unknown, label: string): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError(`${label} exposed an unsafe asynchronous fence`);
  }
  if (typeof then !== "function") return;
  void Promise.resolve(value).catch(() => undefined);
  throw new TypeError(`${label} must complete synchronously`);
}

function token(value: unknown, expectedHostEpoch: string): RelayV2CanonicalResourceResolverToken {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostEpoch", "resourceMappingDigest", "discoveryGeneration",
    ])
    || value.schemaVersion !== 1
    || value.hostEpoch !== expectedHostEpoch) {
    throw new TypeError("H2 resource token is malformed");
  }
  return {
    schemaVersion: 1,
    hostEpoch: bounded(value.hostEpoch),
    resourceMappingDigest: bounded(value.resourceMappingDigest),
    discoveryGeneration: bounded(value.discoveryGeneration),
  };
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length > 64
    || value.some((item) => typeof item !== "string"
      || item.length === 0
      || item.trim() !== item
      || /[\0\r\n]/.test(item)
      || Buffer.byteLength(item, "utf8") > 128)
    || new Set(value).size !== value.length) {
    throw new TypeError("H2 RPC capability evidence is malformed");
  }
  return [...value] as string[];
}

function completeRpcCapabilities(value: readonly string[]): boolean {
  const present = new Set(value);
  return RPC_V2_CAPABILITIES.every((required) => present.has(required));
}

function scopeTarget(
  value: unknown,
  expectedToken: RelayV2CanonicalResourceResolverToken,
  scopeId: string,
  session = false,
): RelayV2CanonicalResolvedScopeTarget {
  if (!isRecord(value)
    || !exactKeys(value, session
      ? [
          "authorization", "hostEpoch", "discoveryGeneration", "scopeId",
          "processTarget", "capabilities", "sessionId", "backendInstanceKey", "managedTarget",
        ]
      : [
          "authorization", "hostEpoch", "discoveryGeneration", "scopeId",
          "processTarget", "capabilities",
        ])
    || value.authorization !== "evidence_only"
    || value.hostEpoch !== expectedToken.hostEpoch
    || value.discoveryGeneration !== expectedToken.discoveryGeneration
    || value.scopeId !== scopeId
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")) {
    throw new TypeError("H2 scope target is malformed");
  }
  return {
    authorization: "evidence_only",
    hostEpoch: expectedToken.hostEpoch,
    discoveryGeneration: expectedToken.discoveryGeneration,
    scopeId,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: bounded(value.processTarget.targetId),
    },
    capabilities: capabilities(value.capabilities),
  };
}

function sessionTarget(
  value: unknown,
  expectedToken: RelayV2CanonicalResourceResolverToken,
  scopeId: string,
  sessionId: string,
): RelayV2CanonicalResolvedSessionTarget {
  const scope = scopeTarget(value, expectedToken, scopeId, true);
  if (!isRecord(value)
    || !exactKeys(value, [
      "authorization", "hostEpoch", "discoveryGeneration", "scopeId",
      "processTarget", "capabilities", "sessionId", "backendInstanceKey", "managedTarget",
    ])
    || value.sessionId !== sessionId
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || typeof value.managedTarget.incarnation !== "string"
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)) {
    throw new TypeError("H2 Session target is malformed");
  }
  return {
    ...scope,
    sessionId,
    backendInstanceKey: bounded(value.backendInstanceKey),
    managedTarget: {
      name: bounded(value.managedTarget.name),
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
  };
}

function resourceFence(
  value: unknown,
  expectedToken: RelayV2CanonicalResourceResolverToken,
  request: RelayV2CanonicalCommandRequest,
): RelayV2CanonicalResourceResolutionFence {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "token", "expectedScopeId", "expectedSessionId", "result",
    ])
    || value.schemaVersion !== 1
    || !same(value.token, expectedToken)
    || value.expectedScopeId !== request.scopeId
    || value.expectedSessionId !== request.sessionId
    || !isRecord(value.result)) {
    throw new TypeError("H2 admission cut is malformed");
  }
  const parsedToken = token(value.token, request.hostEpoch);
  if (value.result.kind === "complete_negative") {
    if (!exactKeys(value.result, ["kind", "code"])
      || (value.result.code !== "SCOPE_NOT_FOUND" && value.result.code !== "SESSION_NOT_FOUND")
      || (request.sessionId === null && value.result.code !== "SCOPE_NOT_FOUND")) {
      throw new TypeError("H2 complete-negative cut is malformed");
    }
    return clone(value) as unknown as RelayV2CanonicalResourceResolutionFence;
  }
  if (value.result.kind !== "positive" || !exactKeys(value.result, ["kind", "target"])) {
    throw new TypeError("H2 positive cut is malformed");
  }
  const target = request.sessionId === null
    ? scopeTarget(value.result.target, parsedToken, request.scopeId)
    : sessionTarget(value.result.target, parsedToken, request.scopeId, request.sessionId);
  return {
    schemaVersion: 1,
    token: parsedToken,
    expectedScopeId: request.scopeId,
    expectedSessionId: request.sessionId,
    result: { kind: "positive", target },
  };
}

function resourceTargetFrom(
  fence: RelayV2CanonicalResourceResolutionFence,
): RelayV2CanonicalResolvedScopeTarget | RelayV2CanonicalResolvedSessionTarget {
  if (fence.result.kind !== "positive") throw new TypeError("H2 target is negative");
  return fence.result.target;
}

function resolverEvidence(
  resourceToken: RelayV2CanonicalResourceResolverToken,
  observedAtMs: number,
): RelayV2CanonicalResolverEvidence {
  return {
    authorityId: bounded(`h2:${resourceToken.resourceMappingDigest}`, 256),
    revision: bounded(resourceToken.discoveryGeneration),
    observedAtMs,
  };
}

function unavailable(now: number): RelayV2CanonicalTargetResolution {
  return {
    kind: "unavailable",
    coverage: "unreachable",
    evidence: {
      authorityId: "h2:unavailable",
      revision: "unavailable",
      observedAtMs: now,
    },
    code: "CAPABILITY_UNAVAILABLE",
  };
}

function createInput(
  request: RelayV2CanonicalCommandRequest,
  target: RelayV2CanonicalResolvedScopeTarget,
): RelayV2CanonicalCreateTargetAuthorityInputV1 {
  return { schemaVersion: 1, request: clone(request), resourceTarget: clone(target) };
}

/**
 * Pure closed-set parser/validator of create target evidence; shared with the
 * create target admission module's private claim wrapper.
 */
export function parseRelayV2CanonicalCreateTargetEvidenceV1(
  value: unknown,
  operation: CreateOperation,
): RelayV2CanonicalCreateTargetAuthorityEvidenceV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "authorityToken", "operation", "arguments", "execution",
      "catalogRevision", "publicDisplayName", "prospectiveSession",
    ])
    || value.schemaVersion !== 1
    || value.operation !== operation
    || !isRecord(value.arguments)
    || !isRecord(value.execution)
    || !isRecord(value.prospectiveSession)) {
    throw new TypeError("canonical create target evidence is malformed");
  }
  bounded(value.authorityToken);
  bounded(value.catalogRevision);
  bounded(value.publicDisplayName);
  return clone(value) as unknown as RelayV2CanonicalCreateTargetAuthorityEvidenceV1;
}

function createResolvedTarget(
  request: RelayV2CanonicalCommandRequest,
  resource: RelayV2CanonicalResolvedScopeTarget,
  evidence: RelayV2CanonicalCreateTargetAuthorityEvidenceV1,
): RelayV2CanonicalResolvedTarget {
  const common = {
    authority: "tw_rpc" as const,
    processTarget: {
      kind: resource.processTarget.kind,
      scopeId: request.scopeId,
      targetId: resource.processTarget.targetId,
    },
    capabilities: [...resource.capabilities],
    publicDisplayName: evidence.publicDisplayName,
    prospectiveSession: clone(evidence.prospectiveSession),
  };
  return evidence.operation === "create_worktree"
    ? {
        ...common,
        operation: "create_worktree",
        arguments: clone(evidence.arguments),
        execution: clone(evidence.execution),
      }
    : {
        ...common,
        operation: "create_terminal",
        arguments: clone(evidence.arguments),
        execution: clone(evidence.execution),
      };
}

function exactTerminalInput(
  request: RelayV2CanonicalCommandRequest,
  target: RelayV2CanonicalResolvedSessionTarget,
): RelayV2ExactTerminalControlTargetInputV1 {
  if (!Number.isSafeInteger(request.arguments.pane) || (request.arguments.pane as number) < 0) {
    throw new TypeError("terminal pane is malformed");
  }
  return {
    schemaVersion: 1,
    hostId: request.hostId,
    scopeId: request.scopeId,
    sessionId: target.sessionId,
    pane: request.arguments.pane as number,
    processTarget: clone(target.processTarget),
    backendInstanceKey: target.backendInstanceKey,
    managedTarget: clone(target.managedTarget),
  };
}

function exactTerminalEvidence(
  value: unknown,
  input: RelayV2ExactTerminalControlTargetInputV1,
): RelayV2ExactTerminalControlTargetEvidenceV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlToken", "exactControlIdentity",
    ])
    || value.schemaVersion !== 1
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.exactControlIdentity.schemaVersion !== 1) {
    throw new TypeError("exact terminal target evidence is malformed");
  }
  const comparable = clone(value) as Record<string, unknown>;
  delete comparable.exactControlToken;
  delete comparable.exactControlIdentity;
  if (!same(comparable, input)) throw new TypeError("exact terminal target crossed H2 cut");
  bounded(value.exactControlToken);
  bounded(value.exactControlIdentity.controlTargetId);
  bounded(value.exactControlIdentity.controlEpoch);
  bounded(value.exactControlIdentity.targetIncarnationProof);
  return clone(value) as unknown as RelayV2ExactTerminalControlTargetEvidenceV1;
}

function terminalBinding(
  input: RelayV2ExactTerminalControlTargetInputV1,
  evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    schemaVersion: 1,
    hostId: input.hostId,
    scopeId: input.scopeId,
    sessionId: input.sessionId,
    pane: input.pane,
    processTarget: clone(input.processTarget),
    backendInstanceKey: input.backendInstanceKey,
    managedTarget: clone(input.managedTarget),
    exactControlIdentity: clone(evidence.exactControlIdentity),
  };
}

function killTarget(
  request: RelayV2CanonicalCommandRequest,
  resource: RelayV2CanonicalResolvedSessionTarget,
): RelayV2CanonicalResolvedTarget {
  return {
    authority: "tw_rpc",
    operation: "kill_session",
    processTarget: {
      kind: resource.processTarget.kind,
      scopeId: request.scopeId,
      targetId: resource.processTarget.targetId,
    },
    capabilities: [...resource.capabilities],
    managedTarget: clone(resource.managedTarget),
  };
}

function envelope(value: unknown): AdmissionEnvelope {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "request", "resourceFence", "commandProof"])
    || value.schemaVersion !== 1
    || !isRecord(value.request)
    || !isRecord(value.resourceFence)
    || !isRecord(value.commandProof)
    || typeof value.commandProof.kind !== "string") {
    throw new TypeError("canonical command admission evidence is malformed");
  }
  return clone(value) as unknown as AdmissionEnvelope;
}

/** Foundation only: this composes existing owners and owns no persistent state. */
export class RelayV2CanonicalCommandTargetAuthorityAdapter
implements RelayV2CanonicalTargetResolverPort {
  private readonly resourceResolver: RelayV2CanonicalResourceResolverPort;
  private readonly createTargetAuthority: RelayV2CanonicalCreateTargetAuthorityPortV1 | undefined;
  private readonly exactTerminalTarget: RelayV2ExactTerminalControlTargetPortV1 | undefined;
  private readonly now: () => number;

  constructor(options: RelayV2CanonicalCommandTargetAuthorityAdapterOptions) {
    if (!isRecord(options)
      || !isRecord(options.resourceResolver)
      || typeof options.resourceResolver.captureToken !== "function"
      || typeof options.resourceResolver.resolveScopeForAdmission !== "function"
      || typeof options.resourceResolver.resolveSessionForAdmission !== "function"
      || typeof options.resourceResolver.fenceResourceCutForAdmission !== "function") {
      throw new TypeError("Relay v2 canonical command target authority requires H2");
    }
    if (options.createTargetAuthority !== undefined
      && (!isRecord(options.createTargetAuthority)
        || typeof options.createTargetAuthority.resolveCreateTarget !== "function"
        || typeof options.createTargetAuthority.fenceCreateTargetForAdmission !== "function")) {
      throw new TypeError("Relay v2 canonical create target authority is invalid");
    }
    if (options.exactTerminalTarget !== undefined
      && (!isRecord(options.exactTerminalTarget)
        || typeof options.exactTerminalTarget.resolveExactTarget !== "function"
        || typeof options.exactTerminalTarget.fenceExactTargetForAdmission !== "function")) {
      throw new TypeError("Relay v2 exact terminal target authority is invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("Relay v2 canonical target clock is invalid");
    }
    this.resourceResolver = options.resourceResolver;
    this.createTargetAuthority = options.createTargetAuthority;
    this.exactTerminalTarget = options.exactTerminalTarget;
    this.now = options.now ?? Date.now;
  }

  async resolve(request: RelayV2CanonicalCommandRequest): Promise<RelayV2CanonicalTargetResolution> {
    const observedAtMs = this.now();
    try {
      const captured = token(
        await this.resourceResolver.captureToken(request.hostEpoch),
        request.hostEpoch,
      );
      const rawFence = request.sessionId === null
        ? await this.resourceResolver.resolveScopeForAdmission(captured, request.scopeId)
        : await this.resourceResolver.resolveSessionForAdmission(
            captured,
            request.scopeId,
            request.sessionId,
          );
      const h2 = resourceFence(rawFence, captured, request);
      const evidence = resolverEvidence(captured, observedAtMs);
      if (h2.result.kind === "complete_negative") {
        const admission: AdmissionEnvelope = {
          schemaVersion: 1,
          request: clone(request),
          resourceFence: clone(h2),
          commandProof: { kind: "negative" },
        };
        return {
          kind: "not_found",
          coverage: "complete",
          evidence,
          code: h2.result.code,
          admissionFence: admission as unknown as RelayV2JsonObject,
        };
      }
      const resource = resourceTargetFrom(h2);
      if (request.authority === "tw_rpc"
        && !completeRpcCapabilities(resource.capabilities)) {
        return unavailable(observedAtMs);
      }

      if (request.operation === "create_worktree" || request.operation === "create_terminal") {
        if (!this.createTargetAuthority || request.sessionId !== null) return unavailable(observedAtMs);
        const input = createInput(request, resource as RelayV2CanonicalResolvedScopeTarget);
        const create = parseRelayV2CanonicalCreateTargetEvidenceV1(
          await this.createTargetAuthority.resolveCreateTarget(clone(input)),
          request.operation,
        );
        const target = createResolvedTarget(request, resource, create);
        const admission: AdmissionEnvelope = {
          schemaVersion: 1,
          request: clone(request),
          resourceFence: clone(h2),
          commandProof: { kind: "create", input, evidence: create },
        };
        return {
          kind: "resolved", coverage: "complete", evidence, target,
          admissionFence: admission as unknown as RelayV2JsonObject,
        };
      }
      const session = resource as RelayV2CanonicalResolvedSessionTarget;
      if (request.operation === "kill_session") {
        const target = killTarget(request, session);
        const admission: AdmissionEnvelope = {
          schemaVersion: 1,
          request: clone(request),
          resourceFence: clone(h2),
          commandProof: { kind: "kill_session" },
        };
        return {
          kind: "resolved", coverage: "complete", evidence, target,
          admissionFence: admission as unknown as RelayV2JsonObject,
        };
      }
      if (!this.exactTerminalTarget) return unavailable(observedAtMs);
      const input = exactTerminalInput(request, session);
      const terminal = exactTerminalEvidence(
        await this.exactTerminalTarget.resolveExactTarget(clone(input)),
        input,
      );
      const target: RelayV2CanonicalResolvedTarget = {
        authority: "terminal_control",
        operation: "send_agent_message",
        targetBinding: terminalBinding(input, terminal),
      };
      const admission: AdmissionEnvelope = {
        schemaVersion: 1,
        request: clone(request),
        resourceFence: clone(h2),
        commandProof: { kind: "terminal", input, evidence: terminal },
      };
      return {
        kind: "resolved", coverage: "complete", evidence, target,
        admissionFence: admission as unknown as RelayV2JsonObject,
      };
    } catch {
      return unavailable(observedAtMs);
    }
  }

  fenceResolution(
    transaction: RelayV2CommandResolutionTransaction,
    request: RelayV2CanonicalCommandRequest,
    fence: RelayV2CommandResolutionFence,
  ): void {
    const admission = envelope(fence.evidence);
    if (!same(admission.request, request)) {
      throw new TypeError("canonical command request changed after resolution");
    }
    const captured = token(admission.resourceFence.token, request.hostEpoch);
    const h2 = resourceFence(admission.resourceFence, captured, request);

    if (fence.outcome === "complete_negative") {
      if (admission.commandProof.kind !== "negative"
        || h2.result.kind !== "complete_negative"
        || fence.code !== h2.result.code) {
        throw new TypeError("canonical negative result is not H2-complete");
      }
    } else {
      if (h2.result.kind !== "positive") {
        throw new TypeError("canonical positive result lost its H2 cut");
      }
      const resource = resourceTargetFrom(h2);
      let expected: RelayV2CanonicalResolvedTarget;
      let fenceCommandOwner: () => void = () => undefined;
      if (admission.commandProof.kind === "create") {
        const proof = admission.commandProof;
        if (!this.createTargetAuthority
          || !same(proof.input, createInput(
            request,
            resource as RelayV2CanonicalResolvedScopeTarget,
          ))) {
          throw new TypeError("canonical create target crossed request or H2 authority");
        }
        const create = parseRelayV2CanonicalCreateTargetEvidenceV1(proof.evidence, request.operation as CreateOperation);
        expected = createResolvedTarget(request, resource, create);
        fenceCommandOwner = () => {
          const result = this.createTargetAuthority!.fenceCreateTargetForAdmission(
            clone(proof.input),
            clone(create),
          );
          requireSynchronous(result, "canonical create target authority fence");
        };
      } else if (admission.commandProof.kind === "terminal") {
        if (!this.exactTerminalTarget
          || request.operation !== "send_agent_message"
          || request.sessionId === null) {
          throw new TypeError("canonical terminal target authority is unavailable");
        }
        const input = exactTerminalInput(
          request,
          resource as RelayV2CanonicalResolvedSessionTarget,
        );
        if (!same(admission.commandProof.input, input)) {
          throw new TypeError("canonical terminal target crossed request or H2 authority");
        }
        const terminal = exactTerminalEvidence(admission.commandProof.evidence, input);
        expected = {
          authority: "terminal_control",
          operation: "send_agent_message",
          targetBinding: terminalBinding(input, terminal),
        };
        fenceCommandOwner = () => {
          const result = this.exactTerminalTarget!.fenceExactTargetForAdmission(
            clone(input),
            clone(terminal),
          );
          requireSynchronous(result, "exact terminal target authority fence");
        };
      } else if (admission.commandProof.kind === "kill_session"
        && request.operation === "kill_session") {
        expected = killTarget(request, resource as RelayV2CanonicalResolvedSessionTarget);
      } else {
        throw new TypeError("canonical command proof does not match the request");
      }
      if (!same(fence.target, expected)) {
        throw new TypeError("canonical command target changed after resolution");
      }
      fenceCommandOwner();
    }

    const fenced = this.resourceResolver.fenceResourceCutForAdmission(
      transaction,
      clone(h2),
    );
    requireSynchronous(fenced, "H2 resource admission fence");
  }
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function parseLease(
  value: unknown,
  binding: RelayV2TerminalCanonicalTargetBindingV1,
  owner: CanonicalTerminalOwner & { kind: "relay-v2" },
): CanonicalTerminalLease {
  if (!isRecord(value)
    || !exactKeys(value, [
      "controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt",
    ])
    || value.controlTargetId !== binding.exactControlIdentity.controlTargetId
    || value.controlEpoch !== binding.exactControlIdentity.controlEpoch
    || !isRecord(value.owner)
    || !exactKeys(value.owner, ["kind", "instanceId"])
    || !same(value.owner, owner)
    || !decimal(value.fence)
    || !timestamp(value.expiresAt)) {
    throw new TypeError("terminal-control acquire result is malformed");
  }
  return {
    controlTargetId: bounded(value.controlTargetId),
    controlEpoch: bounded(value.controlEpoch),
    leaseId: bounded(value.leaseId),
    fence: value.fence,
    owner: clone(owner),
    expiresAt: value.expiresAt,
  };
}

function parseAcquire(
  value: unknown,
  binding: RelayV2TerminalCanonicalTargetBindingV1,
  owner: CanonicalTerminalOwner & { kind: "relay-v2" },
): CanonicalTerminalLease {
  if (!isRecord(value) || !exactKeys(value, ["lease", "ownership"])) {
    throw new TypeError("terminal-control acquire envelope is malformed");
  }
  const lease = parseLease(value.lease, binding, owner);
  if (!isRecord(value.ownership)
    || !exactKeys(value.ownership, [
      "controlTargetId", "controlEpoch", "state", "fence", "ownerKind",
      "leaseExpiresAt", "outputGeneration", "outputCursor", "revision",
    ])
    || value.ownership.controlTargetId !== lease.controlTargetId
    || value.ownership.controlEpoch !== lease.controlEpoch
    || value.ownership.state !== "HELD"
    || value.ownership.fence !== lease.fence
    || value.ownership.ownerKind !== "relay-v2"
    || value.ownership.leaseExpiresAt !== lease.expiresAt
    || typeof value.ownership.outputGeneration !== "string"
    || value.ownership.outputGeneration.length === 0
    || !Number.isSafeInteger(value.ownership.outputCursor)
    || (value.ownership.outputCursor as number) < 0) {
    throw new TypeError("terminal-control acquire ownership is malformed");
  }
  bounded(value.ownership.revision);
  return lease;
}

function parseSend(
  value: unknown,
  operationId: string,
  lease: CanonicalTerminalLease,
): CanonicalAgentMessageResult {
  if (!isRecord(value)
    || !exactKeys(value, [
      "operationId", "accepted", "deduplicated", "controlEpoch", "fence",
      "outputGeneration", "outputCursor",
    ])
    || value.operationId !== operationId
    || value.accepted !== true
    || typeof value.deduplicated !== "boolean"
    || value.controlEpoch !== lease.controlEpoch
    || value.fence !== lease.fence
    || typeof value.outputGeneration !== "string"
    || value.outputGeneration.length === 0
    || !Number.isSafeInteger(value.outputCursor)
    || (value.outputCursor as number) < 0) {
    throw new TypeError("terminal-control send result is malformed");
  }
  return clone(value) as unknown as CanonicalAgentMessageResult;
}

function parseRelease(value: unknown, lease: CanonicalTerminalLease): void {
  if (!isRecord(value)
    || !exactKeys(value, [
      "controlTargetId", "controlEpoch", "state", "fence", "outputGeneration",
      "outputCursor", "revision",
    ])
    || value.controlTargetId !== lease.controlTargetId
    || value.controlEpoch !== lease.controlEpoch
    || value.state !== "FREE"
    || !decimal(value.fence)
    || BigInt(value.fence) <= BigInt(lease.fence)
    || typeof value.outputGeneration !== "string"
    || value.outputGeneration.length === 0
    || !Number.isSafeInteger(value.outputCursor)
    || (value.outputCursor as number) < 0) {
    throw new TypeError("terminal-control release result is uncertain");
  }
  bounded(value.revision);
}

function definiteFailure(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof TerminalControlProtocolError)
    || error.code === "OPERATION_IN_DOUBT"
    || error.code === "INTERNAL") {
    return null;
  }
  return { code: error.code, message: error.message };
}

function executionInput(
  value: Parameters<RelayV2CanonicalTerminalControlExecutionPort["executeAgentMessage"]>[0],
): Parameters<RelayV2CanonicalTerminalControlExecutionPort["executeAgentMessage"]>[0] {
  const binding = value.targetBinding;
  if (!isRecord(value)
    || !isRecord(binding)
    || !exactKeys(binding, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])
    || binding.schemaVersion !== 1
    || !Number.isSafeInteger(binding.pane)
    || binding.pane < 0
    || value.pane !== String(binding.pane)
    || !isRecord(binding.processTarget)
    || !exactKeys(binding.processTarget, ["kind", "targetId"])
    || (binding.processTarget.kind !== "local" && binding.processTarget.kind !== "ssh")
    || !isRecord(binding.managedTarget)
    || !exactKeys(binding.managedTarget, ["name", "kind", "incarnation"])
    || (binding.managedTarget.kind !== "worktree" && binding.managedTarget.kind !== "terminal")
    || typeof binding.managedTarget.incarnation !== "string"
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(binding.managedTarget.incarnation)
    || !isRecord(binding.exactControlIdentity)
    || !exactKeys(binding.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || binding.exactControlIdentity.schemaVersion !== 1
    || !isRecord(value.owner)
    || !exactKeys(value.owner, ["kind", "instanceId"])
    || value.owner.kind !== "relay-v2"
    || typeof value.message !== "string"
    || Buffer.byteLength(value.message, "utf8") > TERMINAL_CONTROL_MAX_INPUT_BYTES
    || typeof value.submit !== "boolean") {
    throw new TypeError("terminal execution input is malformed");
  }
  bounded(binding.hostId);
  bounded(binding.scopeId);
  bounded(binding.sessionId);
  bounded(binding.processTarget.targetId);
  bounded(binding.backendInstanceKey);
  bounded(binding.managedTarget.name);
  bounded(binding.exactControlIdentity.controlTargetId);
  bounded(binding.exactControlIdentity.controlEpoch);
  bounded(binding.exactControlIdentity.targetIncarnationProof);
  bounded(value.owner.instanceId, 256);
  bounded(value.operationId, 192);
  return clone(value);
}

/**
 * Execution-only lease owner. The command executor invokes this port only
 * after H1 has durably committed RUNNING. Each authority operation is attempted
 * at most once; any uncertain acquire/send/release result closes IN_DOUBT.
 */
export class RelayV2CanonicalAgentMessageTerminalExecutionAdapter
implements RelayV2CanonicalTerminalControlExecutionPort {
  constructor(
    private readonly requestPort: RelayV2TerminalControlRequestPort,
    private readonly preparedLeasePort?: RelayV2PreparedExactTerminalControlLeasePortV1,
  ) {
    if (!isRecord(requestPort) || typeof requestPort.request !== "function") {
      throw new TypeError("Relay v2 terminal execution requires terminal-control");
    }
    if (preparedLeasePort !== undefined
      && (!isRecord(preparedLeasePort)
        || typeof preparedLeasePort.consumePreparedLeaseForBinding !== "function")) {
      throw new TypeError("Relay v2 prepared terminal lease authority is invalid");
    }
  }

  async executeAgentMessage(
    input: Parameters<RelayV2CanonicalTerminalControlExecutionPort["executeAgentMessage"]>[0],
  ): ReturnType<RelayV2CanonicalTerminalControlExecutionPort["executeAgentMessage"]> {
    let parsed: typeof input;
    try {
      parsed = executionInput(input);
    } catch {
      return {
        state: "failed",
        sideEffect: "not_applied",
        error: { code: "INVALID_REQUEST", message: "Terminal execution input is invalid" },
      };
    }
    let lease: CanonicalTerminalLease;
    try {
      lease = this.preparedLeasePort === undefined
        ? parseAcquire(await this.requestPort.request({
            type: "lease.acquire",
            controlTargetId: parsed.targetBinding.exactControlIdentity.controlTargetId,
            owner: clone(parsed.owner),
          }), parsed.targetBinding, parsed.owner)
        : parseLease(
            await this.preparedLeasePort.consumePreparedLeaseForBinding(
              clone(parsed.targetBinding),
              clone(parsed.owner),
            ),
            parsed.targetBinding,
            parsed.owner,
          );
    } catch (error) {
      if (this.preparedLeasePort !== undefined) {
        const definite = definiteFailure(error);
        return definite === null
          ? { state: "in_doubt" }
          : { state: "failed", sideEffect: "not_applied", error: definite };
      }
      const definite = definiteFailure(error);
      return definite === null
        ? { state: "in_doubt" }
        : { state: "failed", sideEffect: "not_applied", error: definite };
    }

    let result: RelayV2CanonicalTerminalControlResult;
    try {
      result = {
        state: "succeeded",
        result: parseSend(await this.requestPort.request({
          type: "input.agent-message",
          lease: clone(lease),
          operationId: parsed.operationId,
          pane: parsed.pane,
          message: parsed.message,
          submit: parsed.submit,
        }), parsed.operationId, lease),
      };
    } catch (error) {
      const definite = definiteFailure(error);
      result = definite === null
        ? { state: "in_doubt" }
        : { state: "failed", sideEffect: "not_applied", error: definite };
    }

    try {
      parseRelease(await this.requestPort.request({
        type: "lease.release",
        lease: clone(lease),
      }), lease);
    } catch {
      return { state: "in_doubt" };
    }
    return result;
  }
}
