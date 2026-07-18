import type { RelayV2HostStateTransaction } from "./hostState.js";
import type {
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

export interface RelayV2CanonicalTerminalTargetResolverAdapterOptions {
  resourceResolver: RelayV2CanonicalResourceResolverPort;
  /** Omission is the default NO-GO/read-only state. */
  exactControlTarget?: RelayV2ExactTerminalControlTargetPortV1;
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
      || typeof options.resourceResolver.resolveSession !== "function"
      || typeof options.resourceResolver.fenceSessionForAdmission !== "function") {
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
    const resourceToken = await this.resourceResolver.captureToken(input.hostEpoch);
    const resourceTarget = await this.resourceResolver.resolveSession(
      resourceToken,
      input.target.scopeId,
      input.target.sessionId,
    );
    const exactTargetInput = exactInput(input.target.hostId, input.pane, resourceTarget);
    const exactControlEvidence = parseEvidence(
      await this.exactControlTarget.resolveExactTarget(exactTargetInput),
      exactTargetInput,
    );
    const binding = bindingFrom(exactTargetInput, exactControlEvidence);
    return {
      target: resolvedTargetFrom(input.target, binding),
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
    const exactTargetInput = exactInput(
      resolution.binding.hostId,
      resolution.binding.pane,
      resolution.admission.resourceTarget,
    );
    const exactControlEvidence: RelayV2ExactTerminalControlTargetEvidenceV1 = {
      ...exactTargetInput,
      processTarget: { ...exactTargetInput.processTarget },
      managedTarget: { ...exactTargetInput.managedTarget },
      exactControlToken: resolution.admission.exactControlToken,
      exactControlIdentity: { ...resolution.binding.exactControlIdentity },
    };
    if (!sameInput(exactTargetInput, resolution.binding)) {
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "exact terminal target binding changed before admission",
      );
    }
    const resourceFenceResult: unknown = this.resourceResolver.fenceSessionForAdmission(
      transaction,
      resolution.admission.resourceToken,
      resolution.binding.scopeId,
      resolution.binding.sessionId,
      resolution.admission.resourceTarget,
    );
    requireSynchronousTerminalAdmissionFence(resourceFenceResult, "H2 terminal target fence");
    const exactControlFenceResult: unknown =
      this.exactControlTarget.fenceExactTargetForAdmission(
      exactTargetInput,
      exactControlEvidence,
    );
    requireSynchronousTerminalAdmissionFence(
      exactControlFenceResult,
      "exact terminal-control target fence",
    );
  }
}
