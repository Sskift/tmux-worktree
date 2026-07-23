import type { TerminalControlLease, TerminalControlOwner } from "../../terminalControl/protocol.js";
import type {
  TerminalControlRelayV2ExactTargetClaim,
  TerminalControlRelayV2ExactTargetAuthorityPort,
  TerminalControlRelayV2ExactTargetInput,
} from "../../terminalControl/authority.js";
import { issueRelayV2CanonicalBackendInstanceKey } from "./canonicalBackendIdentity.js";
import type {
  RelayV2ExactTerminalControlTargetEvidenceV1,
  RelayV2ExactTerminalControlTargetInputV1,
  RelayV2PreparedExactTerminalControlLeasePortV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import type { RelayV2TerminalCanonicalTargetBindingV1 } from "./terminalManager.js";

const MAX_ACTIVE_PREPARATIONS = 256;

interface PreparedRecord {
  readonly input: RelayV2ExactTerminalControlTargetInputV1;
  readonly inputJson: string;
  readonly evidence: RelayV2ExactTerminalControlTargetEvidenceV1;
  readonly claim: TerminalControlRelayV2ExactTargetClaim;
  state: "prepared" | "admitted";
  timer: NodeJS.Timeout | null;
}

export interface RelayV2TerminalControlExactTargetAuthorityAdapterOptions {
  authority: TerminalControlRelayV2ExactTargetAuthorityPort;
  owner: TerminalControlOwner & { kind: "relay-v2" };
}

/**
 * The execution-side companion for the exact-target resolver port. The lease
 * is returned once, only after the synchronous H0 fence admitted the claim.
 */
export interface RelayV2PreparedExactTerminalControlTargetPortV1
extends RelayV2PreparedExactTerminalControlLeasePortV1 {
  fenceNewPreparations(): void;
  consumePreparedLease(
    input: RelayV2ExactTerminalControlTargetInputV1,
    evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): TerminalControlLease;
  rollbackPreparedTarget(
    input: RelayV2ExactTerminalControlTargetInputV1,
    evidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): Promise<boolean>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function bounded(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError("Relay v2 exact terminal-control identity is invalid");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

function input(value: unknown): RelayV2ExactTerminalControlTargetInputV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget",
    ])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pane)
    || (value.pane as number) < 0
    || (value.pane as number) > 65_535
    || !isRecord(value.processTarget)
    || !exactKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !isRecord(value.managedTarget)
    || !exactKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || typeof value.managedTarget.incarnation !== "string"
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)) {
    throw new TypeError("Relay v2 exact terminal target input is malformed");
  }
  const parsed: RelayV2ExactTerminalControlTargetInputV1 = {
    schemaVersion: 1,
    hostId: bounded(value.hostId),
    scopeId: bounded(value.scopeId),
    sessionId: bounded(value.sessionId),
    pane: value.pane as number,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: bounded(value.processTarget.targetId),
    },
    backendInstanceKey: bounded(value.backendInstanceKey),
    managedTarget: {
      name: bounded(value.managedTarget.name),
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
  };
  const expectedBackendInstanceKey = issueRelayV2CanonicalBackendInstanceKey({
    processTarget: parsed.processTarget,
    incarnation: parsed.managedTarget.incarnation,
  });
  if (parsed.backendInstanceKey !== expectedBackendInstanceKey) {
    throw new TypeError("Relay v2 exact terminal target crossed backend authority");
  }
  return parsed;
}

function evidence(
  value: unknown,
  expectedInput: RelayV2ExactTerminalControlTargetInputV1,
): RelayV2ExactTerminalControlTargetEvidenceV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlToken", "exactControlIdentity",
    ])
    || !isRecord(value.exactControlIdentity)
    || !exactKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.exactControlIdentity.schemaVersion !== 1) {
    throw new TypeError("Relay v2 exact terminal target evidence is malformed");
  }
  const comparable = { ...value };
  delete comparable.exactControlToken;
  delete comparable.exactControlIdentity;
  if (canonicalJson(comparable) !== canonicalJson(expectedInput)) {
    throw new TypeError("Relay v2 exact terminal target evidence crossed its request");
  }
  return {
    ...expectedInput,
    processTarget: { ...expectedInput.processTarget },
    managedTarget: { ...expectedInput.managedTarget },
    exactControlToken: bounded(value.exactControlToken),
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: bounded(value.exactControlIdentity.controlTargetId),
      controlEpoch: bounded(value.exactControlIdentity.controlEpoch),
      targetIncarnationProof: bounded(value.exactControlIdentity.targetIncarnationProof),
    },
  };
}

function ownerInput(
  resolved: RelayV2ExactTerminalControlTargetInputV1,
  owner: TerminalControlOwner & { kind: "relay-v2" },
): TerminalControlRelayV2ExactTargetInput {
  return {
    ...resolved,
    processTarget: { ...resolved.processTarget },
    managedTarget: { ...resolved.managedTarget },
    owner: { ...owner },
  };
}

function bindingInput(value: RelayV2TerminalCanonicalTargetBindingV1): RelayV2ExactTerminalControlTargetInputV1 {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
      "backendInstanceKey", "managedTarget", "exactControlIdentity",
    ])) {
    throw new TypeError("Relay v2 exact terminal target binding is malformed");
  }
  return input({
    schemaVersion: value.schemaVersion,
    hostId: value.hostId,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    pane: value.pane,
    processTarget: value.processTarget,
    backendInstanceKey: value.backendInstanceKey,
    managedTarget: value.managedTarget,
  });
}

export class RelayV2TerminalControlExactTargetAuthorityAdapter
implements RelayV2PreparedExactTerminalControlTargetPortV1 {
  private readonly authority: TerminalControlRelayV2ExactTargetAuthorityPort;
  private readonly owner: TerminalControlOwner & { kind: "relay-v2" };
  private readonly records = new Map<string, PreparedRecord>();
  private admissionClosed = false;
  private closeBarrier: Promise<void> | null = null;

  constructor(options: RelayV2TerminalControlExactTargetAuthorityAdapterOptions) {
    if (!isRecord(options)
      || !isRecord(options.authority)
      || typeof options.authority.prepareRelayV2ExactTarget !== "function"
      || typeof options.authority.fenceRelayV2ExactTarget !== "function"
      || typeof options.authority.consumeRelayV2ExactTarget !== "function"
      || typeof options.authority.rollbackRelayV2ExactTarget !== "function"
      || !isRecord(options.owner)
      || !exactKeys(options.owner, ["kind", "instanceId"])
      || options.owner.kind !== "relay-v2") {
      throw new TypeError("Relay v2 exact terminal-control authority options are invalid");
    }
    this.authority = options.authority;
    this.owner = Object.freeze({
      kind: "relay-v2",
      instanceId: bounded(options.owner.instanceId, 256),
    });
  }

  async resolveExactTarget(
    rawInput: RelayV2ExactTerminalControlTargetInputV1,
  ): Promise<RelayV2ExactTerminalControlTargetEvidenceV1> {
    if (this.admissionClosed || this.records.size >= MAX_ACTIVE_PREPARATIONS) {
      throw new TypeError("Relay v2 exact terminal-control authority is unavailable");
    }
    const parsed = input(rawInput);
    const prepared = await this.authority.prepareRelayV2ExactTarget(
      ownerInput(parsed, this.owner),
    );
    if (this.admissionClosed) {
      await this.authority.rollbackRelayV2ExactTarget(prepared.claim);
      throw new TypeError("Relay v2 exact terminal-control authority is unavailable");
    }
    const result = Object.freeze({
      ...parsed,
      processTarget: Object.freeze({ ...parsed.processTarget }),
      managedTarget: Object.freeze({ ...parsed.managedTarget }),
      exactControlToken: prepared.preparationId,
      exactControlIdentity: Object.freeze({ ...prepared.identity }),
    });
    const record: PreparedRecord = {
      input: parsed,
      inputJson: canonicalJson(parsed),
      evidence: result,
      claim: prepared.claim,
      state: "prepared",
      timer: null,
    };
    this.records.set(prepared.preparationId, record);
    const delay = Math.max(1, Date.parse(prepared.expiresAt) - Date.now());
    record.timer = setTimeout(() => {
      this.records.delete(prepared.preparationId);
      void this.authority.rollbackRelayV2ExactTarget(prepared.claim).catch(() => undefined);
    }, delay);
    record.timer.unref?.();
    return result;
  }

  fenceExactTargetForAdmission(
    rawInput: RelayV2ExactTerminalControlTargetInputV1,
    rawEvidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): void {
    const parsed = input(rawInput);
    const parsedEvidence = evidence(rawEvidence, parsed);
    const record = this.records.get(parsedEvidence.exactControlToken);
    if (!record
      || record.state !== "prepared"
      || record.inputJson !== canonicalJson(parsed)
      || canonicalJson(record.evidence) !== canonicalJson(parsedEvidence)) {
      if (record) void this.rollbackRecord(parsedEvidence.exactControlToken, record);
      throw new TypeError("Relay v2 exact terminal target preparation is stale or mismatched");
    }
    try {
      this.authority.fenceRelayV2ExactTarget(
        record.claim,
        ownerInput(parsed, this.owner),
      );
      record.state = "admitted";
    } catch (error) {
      void this.rollbackRecord(parsedEvidence.exactControlToken, record);
      throw error;
    }
  }

  consumePreparedLease(
    rawInput: RelayV2ExactTerminalControlTargetInputV1,
    rawEvidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): TerminalControlLease {
    const parsed = input(rawInput);
    const parsedEvidence = evidence(rawEvidence, parsed);
    const record = this.records.get(parsedEvidence.exactControlToken);
    if (!record
      || record.state !== "admitted"
      || record.inputJson !== canonicalJson(parsed)
      || canonicalJson(record.evidence) !== canonicalJson(parsedEvidence)) {
      throw new TypeError("Relay v2 exact terminal target lease is unavailable");
    }
    const lease = this.consumeRecord(
      parsedEvidence.exactControlToken,
      record,
      parsed,
      this.owner,
    );
    return Object.freeze({ ...lease, owner: Object.freeze({ ...lease.owner }) });
  }

  private consumeRecord(
    token: string,
    record: PreparedRecord,
    parsed: RelayV2ExactTerminalControlTargetInputV1,
    consumerOwner: TerminalControlOwner & { kind: "relay-v2" },
  ): TerminalControlLease {
    const lease = this.authority.consumeRelayV2ExactTarget(
      record.claim,
      ownerInput(parsed, this.owner),
      { ...consumerOwner },
    );
    if (record.timer) clearTimeout(record.timer);
    this.records.delete(token);
    return lease;
  }

  consumePreparedLeaseForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    owner: TerminalControlOwner & { kind: "relay-v2" },
  ): TerminalControlLease {
    if (!isRecord(owner)
      || !exactKeys(owner, ["kind", "instanceId"])
      || owner.kind !== "relay-v2"
      || bounded(owner.instanceId, 256) !== owner.instanceId
      || !isRecord(binding.exactControlIdentity)) {
      throw new TypeError("Relay v2 prepared terminal lease owner is invalid");
    }
    const parsed = bindingInput(binding);
    const matches = [...this.records.values()].filter((record) => (
      record.state === "admitted"
      && record.inputJson === canonicalJson(parsed)
      && record.evidence.exactControlIdentity.controlTargetId
        === binding.exactControlIdentity.controlTargetId
      && record.evidence.exactControlIdentity.controlEpoch
        === binding.exactControlIdentity.controlEpoch
      && record.evidence.exactControlIdentity.targetIncarnationProof
        === binding.exactControlIdentity.targetIncarnationProof
    ));
    if (matches.length !== 1) {
      throw new TypeError("Relay v2 prepared terminal lease is unavailable or ambiguous");
    }
    const record = matches[0];
    const lease = this.consumeRecord(
      record.evidence.exactControlToken,
      record,
      parsed,
      owner,
    );
    return Object.freeze({ ...lease, owner: Object.freeze({ ...lease.owner }) });
  }

  async rollbackPreparedTarget(
    rawInput: RelayV2ExactTerminalControlTargetInputV1,
    rawEvidence: RelayV2ExactTerminalControlTargetEvidenceV1,
  ): Promise<boolean> {
    const parsed = input(rawInput);
    const parsedEvidence = evidence(rawEvidence, parsed);
    const record = this.records.get(parsedEvidence.exactControlToken);
    if (!record
      || record.inputJson !== canonicalJson(parsed)
      || canonicalJson(record.evidence) !== canonicalJson(parsedEvidence)) return false;
    return this.rollbackRecord(parsedEvidence.exactControlToken, record);
  }

  private async rollbackRecord(token: string, record: PreparedRecord): Promise<boolean> {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    this.records.delete(token);
    return this.authority.rollbackRelayV2ExactTarget(record.claim);
  }

  fenceNewPreparations(): void {
    this.admissionClosed = true;
  }

  async close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.admissionClosed = true;
    this.closeBarrier = (async () => {
      const records = [...this.records.entries()];
      this.records.clear();
      const settled = await Promise.allSettled(records.map(([token, record]) => (
        this.rollbackRecord(token, record)
      )));
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.closeBarrier;
  }
}
