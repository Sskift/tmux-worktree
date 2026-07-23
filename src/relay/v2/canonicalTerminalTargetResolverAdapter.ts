import type { RelayV2HostStateTransaction } from "./hostState.js";
import type { TerminalControlLease, TerminalControlOwner } from "../../terminalControl/protocol.js";
import type {
  RelayV2CanonicalResourceResolutionFence,
  RelayV2CanonicalResourceResolverToken,
  RelayV2CanonicalResolvedSessionTarget,
  RelayV2CanonicalResourceResolverPort,
} from "./resourceState.js";
import {
  RelayV2TerminalManagerError,
  type RelayV2TerminalCanonicalResolution,
  type RelayV2TerminalCanonicalResolver,
  type RelayV2TerminalCanonicalTargetBindingV1,
  type RelayV2TerminalExactControlIdentityV1,
  type RelayV2TerminalResolvedTarget,
  type RelayV2TerminalWireTarget,
} from "./terminalManager.js";

export const RELAY_V2_EXACT_TERMINAL_CONTROL_TARGET_CONTRACT_VERSION = 1 as const;

export interface RelayV2ExactTerminalControlTargetInputV1 {
  schemaVersion: 1;
  hostId: string;
  scopeId: string;
  sessionId: string;
  pane: number;
  processTarget: {
    kind: "local" | "ssh";
    targetId: string;
  };
  backendInstanceKey: string;
  managedTarget: {
    name: string;
    kind: "worktree" | "terminal";
    incarnation: string;
  };
}

export interface RelayV2ExactTerminalControlTargetEvidenceV1
  extends RelayV2ExactTerminalControlTargetInputV1 {
  exactControlToken: string;
  exactControlIdentity: RelayV2TerminalExactControlIdentityV1;
}

/**
 * Versioned local exact-control authority. This is intentionally independent
 * of frozen terminal-control v1 target.resolve, whose name-only lookup may
 * persist targets and mutate pipe-pane output.
 *
 * Both methods are closed read/verify operations: they must perform zero
 * observation attachment, backend mutation, lease acquisition/renewal,
 * input/resize, output preparation, or target persistence. The synchronous
 * fence must definitely reject a stale token or any changed process target,
 * twinc2 incarnation, pane, control epoch, or target-incarnation proof.
 */
export interface RelayV2ExactTerminalControlTargetPortV1 {
  resolveExactTarget(
    input: RelayV2ExactTerminalControlTargetInputV1,
  ): Promise<RelayV2ExactTerminalControlTargetEvidenceV1>;
  fenceExactTargetForAdmission(
    input: RelayV2ExactTerminalControlTargetInputV1,
    evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): void;
}

/** Execution handoff for an exact claim already admitted by the H0 fence. */
export interface RelayV2PreparedExactTerminalControlLeasePortV1
extends RelayV2ExactTerminalControlTargetPortV1 {
  consumePreparedLeaseForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    owner: TerminalControlOwner & { kind: "relay-v2" },
  ): TerminalControlLease | Promise<TerminalControlLease>;
}

export interface RelayV2CanonicalTerminalTargetResolverAdapterOptions {
  resourceResolver: RelayV2CanonicalResourceResolverPort;
  /** Omission is the default NO-GO/read-only state. */
  exactControlTarget?: RelayV2ExactTerminalControlTargetPortV1;
}

interface RelayV2CanonicalTerminalResolutionRequestV1 {
  hostEpoch: string;
  target: RelayV2TerminalWireTarget;
  pane: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function opaque(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && !/[\0\r\n]/.test(value)
    && value.trim() === value;
}

function parseRequest(value: unknown): RelayV2CanonicalTerminalResolutionRequestV1 {
  if (!isRecord(value)
    || !exactKeys(value, ["auth", "hostEpoch", "target", "pane"])
    || !isRecord(value.auth)
    || !exactKeys(value.auth, ["principalId", "clientInstanceId"])
    || !isRecord(value.target)
    || !exactKeys(value.target, ["hostId", "scopeId", "sessionId"])
    || !opaque(value.auth.principalId)
    || !opaque(value.auth.clientInstanceId)
    || !opaque(value.hostEpoch)
    || !opaque(value.target.hostId)
    || !opaque(value.target.scopeId)
    || !opaque(value.target.sessionId)
    || !Number.isSafeInteger(value.pane)
    || (value.pane as number) < 0
    || (value.pane as number) > 65_535) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "canonical terminal resolution request is malformed",
    );
  }
  return {
    hostEpoch: value.hostEpoch,
    target: {
      hostId: value.target.hostId,
      scopeId: value.target.scopeId,
      sessionId: value.target.sessionId,
    },
    pane: value.pane as number,
  };
}

function parseFenceRequest(
  transaction: RelayV2HostStateTransaction,
  value: unknown,
): RelayV2CanonicalTerminalResolutionRequestV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
    ])
    || !opaque(value.hostId)
    || !opaque(value.scopeId)
    || !opaque(value.sessionId)
    || !Number.isSafeInteger(value.pane)
    || (value.pane as number) < 0
    || (value.pane as number) > 65_535
    || !opaque(value.canonicalTargetId)
    || !opaque(value.controlTargetId)
    || !opaque(transaction.hostEpoch)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "canonical terminal resolution target is malformed before admission",
    );
  }
  return {
    hostEpoch: transaction.hostEpoch,
    target: {
      hostId: value.hostId,
      scopeId: value.scopeId,
      sessionId: value.sessionId,
    },
    pane: value.pane as number,
  };
}

function parseResourceToken(
  value: unknown,
  expectedHostEpoch: string,
): RelayV2CanonicalResourceResolverToken {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostEpoch", "resourceMappingDigest", "discoveryGeneration",
    ])
    || value.schemaVersion !== 1
    || value.hostEpoch !== expectedHostEpoch
    || !opaque(value.resourceMappingDigest)
    || !opaque(value.discoveryGeneration)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "H2 terminal resolution token is malformed",
    );
  }
  return {
    schemaVersion: 1,
    hostEpoch: expectedHostEpoch,
    resourceMappingDigest: value.resourceMappingDigest,
    discoveryGeneration: value.discoveryGeneration,
  };
}

function parseResourceTarget(
  value: unknown,
  request: RelayV2CanonicalTerminalResolutionRequestV1,
  resourceToken: RelayV2CanonicalResourceResolverToken,
): RelayV2CanonicalResolvedSessionTarget {
  if (!isRecord(value)
    || !exactKeys(value, [
      "authorization", "hostEpoch", "discoveryGeneration", "scopeId", "processTarget",
      "capabilities", "sessionId", "backendInstanceKey", "managedTarget",
    ])
    || value.authorization !== "evidence_only"
    || value.hostEpoch !== request.hostEpoch
    || value.discoveryGeneration !== resourceToken.discoveryGeneration
    || value.scopeId !== request.target.scopeId
    || value.sessionId !== request.target.sessionId
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !opaque(value.processTarget.targetId)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length > 64
    || value.capabilities.some((capability) => !opaque(capability))
    || new Set(value.capabilities).size !== value.capabilities.length
    || !opaque(value.backendInstanceKey)
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || !opaque(value.managedTarget.name)
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || !opaque(value.managedTarget.incarnation)
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "H2 terminal target evidence is malformed or crossed authority",
    );
  }
  return {
    authorization: "evidence_only",
    hostEpoch: request.hostEpoch,
    discoveryGeneration: resourceToken.discoveryGeneration,
    scopeId: request.target.scopeId,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: value.processTarget.targetId,
    },
    capabilities: [...value.capabilities] as string[],
    sessionId: request.target.sessionId,
    backendInstanceKey: value.backendInstanceKey,
    managedTarget: {
      name: value.managedTarget.name,
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
  };
}

function parseResourceFence(
  value: unknown,
  request: RelayV2CanonicalTerminalResolutionRequestV1,
  expectedToken?: RelayV2CanonicalResourceResolverToken,
): RelayV2CanonicalResourceResolutionFence {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "token", "expectedScopeId", "expectedSessionId", "result",
    ])
    || value.schemaVersion !== 1
    || value.expectedScopeId !== request.target.scopeId
    || value.expectedSessionId !== request.target.sessionId
    || !isRecord(value.result)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "H2 terminal admission cut is malformed",
    );
  }
  const resourceToken = parseResourceToken(value.token, request.hostEpoch);
  if (expectedToken !== undefined && (
    resourceToken.resourceMappingDigest !== expectedToken.resourceMappingDigest
    || resourceToken.discoveryGeneration !== expectedToken.discoveryGeneration
  )) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "H2 terminal admission cut changed after capture",
    );
  }
  if (value.result.kind === "complete_negative") {
    if (!exactKeys(value.result, ["kind", "code"])
      || (value.result.code !== "SCOPE_NOT_FOUND" && value.result.code !== "SESSION_NOT_FOUND")) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "H2 terminal negative cut is malformed",
      );
    }
    throw new RelayV2TerminalManagerError(
      value.result.code,
      "H2 terminal target is absent from the complete materialized cut",
    );
  }
  if (value.result.kind !== "positive" || !exactKeys(value.result, ["kind", "target"])) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "H2 terminal positive cut is malformed",
    );
  }
  return {
    schemaVersion: 1,
    token: resourceToken,
    expectedScopeId: request.target.scopeId,
    expectedSessionId: request.target.sessionId,
    result: {
      kind: "positive",
      target: parseResourceTarget(value.result.target, request, resourceToken),
    },
  };
}

function cloneResourceFence(
  fence: RelayV2CanonicalResourceResolutionFence,
): RelayV2CanonicalResourceResolutionFence {
  if (fence.result.kind !== "positive") {
    return {
      ...fence,
      token: { ...fence.token },
      result: { ...fence.result },
    };
  }
  return {
    ...fence,
    token: { ...fence.token },
    result: {
      kind: "positive",
      target: {
        ...fence.result.target,
        processTarget: { ...fence.result.target.processTarget },
        capabilities: [...fence.result.target.capabilities],
        ...(Object.hasOwn(fence.result.target, "sessionId")
          ? {
              managedTarget: {
                ...(fence.result.target as RelayV2CanonicalResolvedSessionTarget).managedTarget,
              },
            }
          : {}),
      },
    },
  };
}

/** Reject every asynchronous fence shape while safely observing rejection. */
function requireSynchronousTerminalAdmissionFence(
  value: unknown,
  label: string,
): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    void Promise.resolve(value).catch(() => undefined);
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      `${label} exposed an unsafe asynchronous fence`,
    );
  }
  if (typeof then !== "function") return;
  void Promise.resolve(value).catch(() => undefined);
  throw new RelayV2TerminalManagerError(
    "CAPABILITY_UNAVAILABLE",
    `${label} must complete synchronously`,
  );
}

function sameInput(
  left: RelayV2ExactTerminalControlTargetInputV1,
  right: RelayV2ExactTerminalControlTargetInputV1,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.hostId === right.hostId
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId
    && left.pane === right.pane
    && left.processTarget.kind === right.processTarget.kind
    && left.processTarget.targetId === right.processTarget.targetId
    && left.backendInstanceKey === right.backendInstanceKey
    && left.managedTarget.name === right.managedTarget.name
    && left.managedTarget.kind === right.managedTarget.kind
    && left.managedTarget.incarnation === right.managedTarget.incarnation;
}

function exactInput(
  hostId: string,
  pane: number,
  target: RelayV2CanonicalResolvedSessionTarget,
): RelayV2ExactTerminalControlTargetInputV1 {
  return {
    schemaVersion: 1,
    hostId,
    scopeId: target.scopeId,
    sessionId: target.sessionId,
    pane,
    processTarget: { ...target.processTarget },
    backendInstanceKey: target.backendInstanceKey,
    managedTarget: { ...target.managedTarget },
  };
}

function parseEvidence(
  value: unknown,
  expected: RelayV2ExactTerminalControlTargetInputV1,
): RelayV2ExactTerminalControlTargetEvidenceV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlToken", "exactControlIdentity",
    ])
    || value.schemaVersion !== 1
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "exact terminal-control target evidence is malformed",
    );
  }
  const candidate = value as unknown as RelayV2ExactTerminalControlTargetEvidenceV1;
  if (!sameInput(candidate, expected)
    || !opaque(candidate.exactControlToken)
    || candidate.exactControlIdentity.schemaVersion !== 1
    || !opaque(candidate.exactControlIdentity.controlTargetId)
    || !opaque(candidate.exactControlIdentity.controlEpoch)
    || !opaque(candidate.exactControlIdentity.targetIncarnationProof)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "exact terminal-control target cannot be proven",
    );
  }
  return {
    ...expected,
    processTarget: { ...expected.processTarget },
    managedTarget: { ...expected.managedTarget },
    exactControlToken: candidate.exactControlToken,
    exactControlIdentity: { ...candidate.exactControlIdentity },
  };
}

function bindingFrom(
  input: RelayV2ExactTerminalControlTargetInputV1,
  evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    schemaVersion: 1,
    hostId: input.hostId,
    scopeId: input.scopeId,
    sessionId: input.sessionId,
    pane: input.pane,
    processTarget: { ...input.processTarget },
    backendInstanceKey: input.backendInstanceKey,
    managedTarget: { ...input.managedTarget },
    exactControlIdentity: { ...evidence.exactControlIdentity },
  };
}

function parseBinding(
  value: unknown,
  expected: RelayV2ExactTerminalControlTargetInputV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "canonical terminal target binding is malformed",
    );
  }
  const candidate = value as unknown as RelayV2TerminalCanonicalTargetBindingV1;
  if (!sameInput(candidate, expected)
    || candidate.exactControlIdentity.schemaVersion !== 1
    || !opaque(candidate.exactControlIdentity.controlTargetId)
    || !opaque(candidate.exactControlIdentity.controlEpoch)
    || !opaque(candidate.exactControlIdentity.targetIncarnationProof)) {
    throw new RelayV2TerminalManagerError(
      "CAPABILITY_UNAVAILABLE",
      "canonical terminal target binding crossed authority",
    );
  }
  return {
    ...expected,
    processTarget: { ...expected.processTarget },
    managedTarget: { ...expected.managedTarget },
    exactControlIdentity: { ...candidate.exactControlIdentity },
  };
}

function resolvedTargetFrom(
  target: RelayV2TerminalWireTarget,
  binding: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalResolvedTarget {
  return {
    ...target,
    pane: binding.pane,
    canonicalTargetId: binding.backendInstanceKey,
    controlTargetId: binding.exactControlIdentity.controlTargetId,
  };
}

/** Foundation only: no production composition constructs this adapter. */
export class RelayV2CanonicalTerminalTargetResolverAdapter
  implements RelayV2TerminalCanonicalResolver {
  private readonly resourceResolver: RelayV2CanonicalResourceResolverPort;
  private readonly exactControlTarget: RelayV2ExactTerminalControlTargetPortV1 | undefined;

  constructor(options: RelayV2CanonicalTerminalTargetResolverAdapterOptions) {
    if (!isRecord(options)
      || !isRecord(options.resourceResolver)
      || typeof options.resourceResolver.captureToken !== "function"
      || typeof options.resourceResolver.resolveSessionForAdmission !== "function"
      || typeof options.resourceResolver.fenceResourceCutForAdmission !== "function") {
      throw new TypeError("Relay v2 canonical terminal target resolver requires H2");
    }
    if (options.exactControlTarget !== undefined
      && (!isRecord(options.exactControlTarget)
        || typeof options.exactControlTarget.resolveExactTarget !== "function"
        || typeof options.exactControlTarget.fenceExactTargetForAdmission !== "function")) {
      throw new TypeError("Relay v2 exact terminal-control target port is invalid");
    }
    this.resourceResolver = options.resourceResolver;
    this.exactControlTarget = options.exactControlTarget;
  }

  async resolve(input: {
    auth: { principalId: string; clientInstanceId: string };
    hostEpoch: string;
    target: RelayV2TerminalWireTarget;
    pane: number;
  }): Promise<RelayV2TerminalCanonicalResolution> {
    if (!this.exactControlTarget) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "exact terminal-control target authority is not wired",
      );
    }
    const request = parseRequest(input);
    const resourceToken = parseResourceToken(
      await this.resourceResolver.captureToken(request.hostEpoch),
      request.hostEpoch,
    );
    const resourceFence = parseResourceFence(
      await this.resourceResolver.resolveSessionForAdmission(
        resourceToken,
        request.target.scopeId,
        request.target.sessionId,
      ),
      request,
      resourceToken,
    );
    if (resourceFence.result.kind !== "positive"
      || !Object.hasOwn(resourceFence.result.target, "sessionId")) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "H2 terminal admission cut did not resolve an exact Session",
      );
    }
    const resourceTarget = resourceFence.result.target as RelayV2CanonicalResolvedSessionTarget;
    const exactTargetInput = exactInput(request.target.hostId, request.pane, resourceTarget);
    const exactControlEvidence = parseEvidence(
      await this.exactControlTarget.resolveExactTarget(exactTargetInput),
      exactTargetInput,
    );
    const binding = bindingFrom(exactTargetInput, exactControlEvidence);
    return {
      target: resolvedTargetFrom(request.target, binding),
      binding,
      admission: {
        resourceToken: { ...resourceToken },
        resourceTarget: {
          ...resourceTarget,
          processTarget: { ...resourceTarget.processTarget },
          capabilities: [...resourceTarget.capabilities],
          managedTarget: { ...resourceTarget.managedTarget },
        },
        exactControlToken: exactControlEvidence.exactControlToken,
      },
    };
  }

  fenceSessionForAdmission(
    transaction: RelayV2HostStateTransaction,
    resolution: RelayV2TerminalCanonicalResolution,
  ): void {
    if (!this.exactControlTarget) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "exact terminal-control target authority is not wired",
      );
    }
    if (!isRecord(resolution)
      || !exactKeys(resolution, ["target", "binding", "admission"])
      || !isRecord(resolution.target)
      || !exactKeys(resolution.target, [
        "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
      ])
      || !isRecord(resolution.admission)
      || !exactKeys(resolution.admission, [
        "resourceToken", "resourceTarget", "exactControlToken",
      ])) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "canonical terminal resolution is malformed before admission",
      );
    }
    const request = parseFenceRequest(transaction, resolution.target);
    const resourceToken = parseResourceToken(
      resolution.admission.resourceToken,
      request.hostEpoch,
    );
    const resourceFence = parseResourceFence({
      schemaVersion: 1,
      token: resourceToken,
      expectedScopeId: request.target.scopeId,
      expectedSessionId: request.target.sessionId,
      result: {
        kind: "positive",
        target: resolution.admission.resourceTarget,
      },
    }, request, resourceToken);
    if (!opaque(resolution.admission.exactControlToken)) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "canonical terminal exact-control token is malformed",
      );
    }
    if (resourceFence.result.kind !== "positive"
      || !Object.hasOwn(resourceFence.result.target, "sessionId")) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "canonical terminal resolution lost its exact H2 Session",
      );
    }
    const resourceTarget = resourceFence.result.target as RelayV2CanonicalResolvedSessionTarget;
    const exactTargetInput = exactInput(request.target.hostId, request.pane, resourceTarget);
    const binding = parseBinding(resolution.binding, exactTargetInput);
    const exactControlEvidence = parseEvidence({
      ...exactTargetInput,
      processTarget: { ...exactTargetInput.processTarget },
      managedTarget: { ...exactTargetInput.managedTarget },
      exactControlToken: resolution.admission.exactControlToken,
      exactControlIdentity: { ...binding.exactControlIdentity },
    }, exactTargetInput);
    const expectedBinding = bindingFrom(exactTargetInput, exactControlEvidence);
    const expectedTarget = resolvedTargetFrom(request.target, expectedBinding);
    if (binding.exactControlIdentity.schemaVersion
        !== expectedBinding.exactControlIdentity.schemaVersion
      || binding.exactControlIdentity.controlTargetId
        !== expectedBinding.exactControlIdentity.controlTargetId
      || binding.exactControlIdentity.controlEpoch
        !== expectedBinding.exactControlIdentity.controlEpoch
      || binding.exactControlIdentity.targetIncarnationProof
        !== expectedBinding.exactControlIdentity.targetIncarnationProof
      || resolution.target.hostId !== expectedTarget.hostId
      || resolution.target.scopeId !== expectedTarget.scopeId
      || resolution.target.sessionId !== expectedTarget.sessionId
      || resolution.target.pane !== expectedTarget.pane
      || resolution.target.canonicalTargetId !== expectedTarget.canonicalTargetId
      || resolution.target.controlTargetId !== expectedTarget.controlTargetId) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "canonical terminal request or exact target changed before admission",
      );
    }
    const exactControlFenceResult: unknown =
      this.exactControlTarget.fenceExactTargetForAdmission(
        exactTargetInput,
        exactControlEvidence,
      );
    requireSynchronousTerminalAdmissionFence(
      exactControlFenceResult,
      "exact terminal-control target fence",
    );
    const resourceFenceResult: unknown = this.resourceResolver.fenceResourceCutForAdmission(
      transaction,
      cloneResourceFence(resourceFence),
    );
    requireSynchronousTerminalAdmissionFence(resourceFenceResult, "H2 terminal target fence");
  }
}
