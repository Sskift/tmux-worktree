import {
  requestTerminalControl,
  type TerminalControlRequestInput,
} from "./terminalControl/client.js";
import {
  TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT,
  TERMINAL_CONTROL_MAX_FRAME_BYTES,
  TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES,
  TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES,
  TERMINAL_CONTROL_PROTOCOL_VERSION,
  type TerminalControlDrainProof,
  type TerminalControlLease,
  type TerminalControlOwner,
  type TerminalControlOwnerKind,
  type TerminalControlOwnershipView,
} from "./terminalControl/protocol.js";
import { terminalControlSocketPath } from "./terminalControl/store.js";

export const CANONICAL_TERMINAL_CONTROL_PROTOCOL_VERSION = TERMINAL_CONTROL_PROTOCOL_VERSION;
export const CANONICAL_TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT = TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT;
export const CANONICAL_TERMINAL_CONTROL_MAX_FRAME_BYTES = TERMINAL_CONTROL_MAX_FRAME_BYTES;
export const CANONICAL_TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES = TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES;
export const CANONICAL_TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES = TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES;
export const CANONICAL_TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES = TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES;

export type CanonicalTerminalOwnerKind = TerminalControlOwnerKind;
export type CanonicalTerminalOwner = TerminalControlOwner;
export type CanonicalTerminalLease = TerminalControlLease;
export type CanonicalTerminalOwnershipState = TerminalControlOwnershipView["state"];
export type CanonicalTerminalOwnership = TerminalControlOwnershipView;

export interface CanonicalManagedSession {
  name: string;
  kind: "worktree" | "terminal";
  createdAt: string;
}

export interface CanonicalTargetResolution {
  controlTargetId: string;
  controlEpoch: string;
  managedSession: CanonicalManagedSession;
  ownership: CanonicalTerminalOwnership;
}

export interface CanonicalLeaseResult {
  lease: CanonicalTerminalLease;
  ownership: CanonicalTerminalOwnership;
}

export interface CanonicalHandoffResult {
  ownership: CanonicalTerminalOwnership;
  lease?: CanonicalTerminalLease;
}

export type CanonicalDrainRecord = TerminalControlDrainProof;

export interface CanonicalAgentMessageResult {
  operationId: string;
  accepted: true;
  deduplicated: boolean;
  controlEpoch: string;
  fence: string;
  outputGeneration: string;
  outputCursor: number;
}

export interface CanonicalOutputTailResult {
  controlTargetId: string;
  controlEpoch: string;
  fence: string;
  ownerKind?: CanonicalTerminalOwnerKind;
  outputGeneration: string;
  cursor: number;
  dataBase64: string;
  nextCursor: number;
}

export interface CanonicalRenderedSnapshotResult {
  controlTargetId: string;
  controlEpoch: string;
  leaseId: string;
  fence: string;
  ownerKind: "feishu";
  outputGeneration: string;
  pane: string;
  dataBase64: string;
  truncated: boolean;
}

export interface CanonicalRenderedSnapshotInput {
  lease: CanonicalTerminalLease;
  outputGeneration: string;
  pane: string;
  maxBytes?: number;
}

export interface CanonicalTerminalControlCapabilities {
  renderedSnapshot: boolean;
}

export interface CanonicalTerminalControlClient {
  capabilities(): Promise<CanonicalTerminalControlCapabilities>;
  resolveTarget(sessionName: string): Promise<CanonicalTargetResolution>;
  ownershipStatus(controlTargetId: string): Promise<CanonicalTerminalOwnership>;
  acquireLease(
    controlTargetId: string,
    owner: CanonicalTerminalOwner,
    ttlMs?: number,
  ): Promise<CanonicalLeaseResult>;
  renewLease(lease: CanonicalTerminalLease, ttlMs?: number): Promise<CanonicalLeaseResult>;
  releaseLease(lease: CanonicalTerminalLease): Promise<CanonicalTerminalOwnership>;
  beginHandoff(
    controlTargetId: string,
    nextOwner: CanonicalTerminalOwner,
    currentLease?: CanonicalTerminalLease,
  ): Promise<CanonicalHandoffResult>;
  commitHandoff(
    handoffId: string,
    currentLease: CanonicalTerminalLease,
    drain: CanonicalDrainRecord,
    ttlMs?: number,
  ): Promise<CanonicalHandoffResult>;
  cancelHandoff(
    handoffId: string,
    currentLease: CanonicalTerminalLease,
  ): Promise<CanonicalTerminalOwnership>;
  withdrawHandoff(
    controlTargetId: string,
    handoffId: string,
    nextOwner: CanonicalTerminalOwner,
  ): Promise<CanonicalTerminalOwnership>;
  sendAgentMessage(input: {
    lease: CanonicalTerminalLease;
    operationId: string;
    pane: string;
    message: string;
    submit: boolean;
  }): Promise<CanonicalAgentMessageResult>;
  tailOutput(input: {
    controlTargetId: string;
    controlEpoch: string;
    outputGeneration: string;
    cursor: number;
    maxBytes?: number;
  }): Promise<CanonicalOutputTailResult>;
  renderedSnapshot(input: CanonicalRenderedSnapshotInput): Promise<CanonicalRenderedSnapshotResult>;
}

export class CanonicalTerminalControlError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "CanonicalTerminalControlError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function requiredString(value: unknown, field: string, maxBytes = 1024): string {
  if (typeof value !== "string" || !value || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      `canonical terminal-control returned invalid ${field}`,
    );
  }
  return value;
}

function decimal(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  if (!/^(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      `canonical terminal-control returned invalid ${field}`,
    );
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      `canonical terminal-control returned invalid ${field}`,
    );
  }
  return value as number;
}

function owner(value: unknown, field = "owner"): CanonicalTerminalOwner {
  if (!isRecord(value)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", `canonical terminal-control returned invalid ${field}`);
  }
  const kinds: CanonicalTerminalOwnerKind[] = [
    "feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve",
  ];
  if (!kinds.includes(value.kind as CanonicalTerminalOwnerKind)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", `canonical terminal-control returned invalid ${field}.kind`);
  }
  return {
    kind: value.kind as CanonicalTerminalOwnerKind,
    instanceId: requiredString(value.instanceId, `${field}.instanceId`),
  };
}

function lease(value: unknown): CanonicalTerminalLease {
  if (!isRecord(value)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid lease");
  }
  const expiresAt = canonicalTimestamp(value.expiresAt, "lease.expiresAt");
  return {
    controlTargetId: requiredString(value.controlTargetId, "lease.controlTargetId"),
    controlEpoch: requiredString(value.controlEpoch, "lease.controlEpoch"),
    leaseId: requiredString(value.leaseId, "lease.leaseId"),
    fence: decimal(value.fence, "lease.fence"),
    owner: owner(value.owner, "lease.owner"),
    expiresAt,
  };
}

function ownerKind(value: unknown, field: string): CanonicalTerminalOwnerKind | undefined {
  if (value === undefined) return undefined;
  const kinds: CanonicalTerminalOwnerKind[] = [
    "feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve",
  ];
  if (!kinds.includes(value as CanonicalTerminalOwnerKind)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", `canonical terminal-control returned invalid ${field}`);
  }
  return value as CanonicalTerminalOwnerKind;
}

function requiredOwnerKind(value: unknown, field: string): CanonicalTerminalOwnerKind {
  const parsed = ownerKind(value, field);
  if (parsed === undefined) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      `canonical terminal-control returned invalid ${field}`,
    );
  }
  return parsed;
}

function validateRenderedSnapshotInput(input: CanonicalRenderedSnapshotInput): void {
  if (input.lease.owner.kind !== "feishu"
    || input.pane !== "0"
    || typeof input.outputGeneration !== "string"
    || !input.outputGeneration
    || input.outputGeneration.includes("\0")
    || Buffer.byteLength(input.outputGeneration, "utf8") > 128
    || (input.maxBytes !== undefined
      && (!Number.isSafeInteger(input.maxBytes)
        || input.maxBytes < 1
        || input.maxBytes > CANONICAL_TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES))) {
    throw new CanonicalTerminalControlError(
      "INVALID_REQUEST",
      "canonical terminal-control rendered snapshot bounds are invalid",
    );
  }
}

export function parseCanonicalRenderedSnapshotResult(
  value: unknown,
  input: CanonicalRenderedSnapshotInput,
): CanonicalRenderedSnapshotResult {
  validateRenderedSnapshotInput(input);
  if (!isRecord(value)
    || !exactKeys(value, [
      "controlTargetId",
      "controlEpoch",
      "leaseId",
      "fence",
      "ownerKind",
      "outputGeneration",
      "pane",
      "dataBase64",
      "truncated",
    ])
    || typeof value.truncated !== "boolean") {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      "canonical terminal-control returned invalid rendered snapshot",
    );
  }
  const dataBase64 = typeof value.dataBase64 === "string" ? value.dataBase64 : "";
  const data = Buffer.from(dataBase64, "base64");
  const maxBytes = input.maxBytes ?? CANONICAL_TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES;
  let validUtf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    validUtf8 = false;
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
    || data.toString("base64") !== dataBase64
    || data.byteLength > maxBytes
    || !validUtf8) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      "canonical terminal-control returned invalid rendered snapshot dataBase64",
    );
  }
  const parsedOwnerKind = requiredOwnerKind(value.ownerKind, "snapshot.ownerKind");
  if (parsedOwnerKind !== "feishu") {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      "canonical terminal-control returned mismatched rendered snapshot correlation",
    );
  }
  const result: CanonicalRenderedSnapshotResult = {
    controlTargetId: requiredString(value.controlTargetId, "snapshot.controlTargetId"),
    controlEpoch: requiredString(value.controlEpoch, "snapshot.controlEpoch"),
    leaseId: requiredString(value.leaseId, "snapshot.leaseId"),
    fence: decimal(value.fence, "snapshot.fence"),
    ownerKind: parsedOwnerKind,
    outputGeneration: requiredString(value.outputGeneration, "snapshot.outputGeneration"),
    pane: requiredString(value.pane, "snapshot.pane", 8),
    dataBase64,
    truncated: value.truncated,
  };
  if (result.controlTargetId !== input.lease.controlTargetId
    || result.controlEpoch !== input.lease.controlEpoch
    || result.leaseId !== input.lease.leaseId
    || result.fence !== input.lease.fence
    || result.outputGeneration !== input.outputGeneration
    || result.pane !== input.pane) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      "canonical terminal-control returned mismatched rendered snapshot correlation",
    );
  }
  return result;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      `canonical terminal-control returned invalid ${field}`,
    );
  }
  return parsed;
}

function ownership(value: unknown): CanonicalTerminalOwnership {
  if (!isRecord(value)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid ownership");
  }
  const states: CanonicalTerminalOwnershipState[] = [
    "FREE", "HELD", "DRAINING", "RECOVERY_REQUIRED", "TARGET_GONE",
  ];
  if (!states.includes(value.state as CanonicalTerminalOwnershipState)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid ownership.state");
  }
  return {
    controlTargetId: requiredString(value.controlTargetId, "ownership.controlTargetId"),
    controlEpoch: requiredString(value.controlEpoch, "ownership.controlEpoch"),
    state: value.state as CanonicalTerminalOwnershipState,
    fence: decimal(value.fence, "ownership.fence"),
    revision: requiredString(value.revision, "ownership.revision"),
    ...(value.ownerKind === undefined ? {} : { ownerKind: ownerKind(value.ownerKind, "ownership.ownerKind") }),
    ...(value.nextOwnerKind === undefined ? {} : { nextOwnerKind: ownerKind(value.nextOwnerKind, "ownership.nextOwnerKind") }),
    ...(value.handoffId === undefined ? {} : { handoffId: requiredString(value.handoffId, "ownership.handoffId") }),
    ...(value.leaseExpiresAt === undefined ? {} : {
      leaseExpiresAt: canonicalTimestamp(value.leaseExpiresAt, "ownership.leaseExpiresAt"),
    }),
    outputGeneration: requiredString(value.outputGeneration, "ownership.outputGeneration"),
    outputCursor: nonNegativeInteger(value.outputCursor, "ownership.outputCursor"),
  };
}

function leaseResult(value: unknown): CanonicalLeaseResult {
  if (!isRecord(value)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid lease result");
  }
  const parsedLease = lease(value.lease);
  const parsedOwnership = ownership(value.ownership);
  assertLeaseOwnershipCorrelation(parsedLease, parsedOwnership);
  return { lease: parsedLease, ownership: parsedOwnership };
}

function handoffResult(value: unknown): CanonicalHandoffResult {
  if (!isRecord(value)) {
    throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid handoff result");
  }
  const parsedOwnership = ownership(value.ownership);
  const parsedLease = value.lease === undefined ? undefined : lease(value.lease);
  if (parsedLease) assertLeaseOwnershipCorrelation(parsedLease, parsedOwnership);
  return { ownership: parsedOwnership, ...(parsedLease === undefined ? {} : { lease: parsedLease }) };
}

function assertLeaseOwnershipCorrelation(
  parsedLease: CanonicalTerminalLease,
  parsedOwnership: CanonicalTerminalOwnership,
): void {
  if (parsedOwnership.controlTargetId !== parsedLease.controlTargetId
    || parsedOwnership.controlEpoch !== parsedLease.controlEpoch
    || parsedOwnership.fence !== parsedLease.fence
    || parsedOwnership.ownerKind !== parsedLease.owner.kind
    || (parsedOwnership.state !== "HELD" && parsedOwnership.state !== "DRAINING")) {
    throw new CanonicalTerminalControlError(
      "CONTROLLER_UNAVAILABLE",
      "canonical terminal-control returned an inconsistent lease and ownership view",
    );
  }
}

export function canonicalTerminalControlSocketPath(home?: string): string {
  return terminalControlSocketPath(home);
}

export class CanonicalTerminalControlSocketClient implements CanonicalTerminalControlClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: { socketPath?: string; timeoutMs?: number } = {}) {
    this.socketPath = options.socketPath ?? canonicalTerminalControlSocketPath();
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async capabilities(): Promise<CanonicalTerminalControlCapabilities> {
    const value = await this.request("ping", {});
    if (!isRecord(value)
      || value.protocolVersion !== CANONICAL_TERMINAL_CONTROL_PROTOCOL_VERSION
      || value.authority !== "local-terminal-control") {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned invalid capability information",
      );
    }
    if (value.capabilities === undefined) {
      return { renderedSnapshot: false };
    }
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 64) {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned invalid capabilities",
      );
    }
    const capabilities = value.capabilities.map((capability) =>
      requiredString(capability, "capabilities[]", 128));
    if (new Set(capabilities).size !== capabilities.length) {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned duplicate capabilities",
      );
    }
    return {
      renderedSnapshot: capabilities.includes(
        CANONICAL_TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT,
      ),
    };
  }

  async resolveTarget(sessionName: string): Promise<CanonicalTargetResolution> {
    const value = await this.request("target.resolve", { sessionName });
    if (!isRecord(value) || !isRecord(value.managedSession)) {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid target resolution");
    }
    const managedKind = value.managedSession.kind;
    if (managedKind !== "worktree" && managedKind !== "terminal") {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid managed session kind");
    }
    const controlTargetId = requiredString(value.controlTargetId, "controlTargetId");
    const controlEpoch = requiredString(value.controlEpoch, "controlEpoch");
    const parsedOwnership = ownership(value.ownership);
    if (parsedOwnership.controlTargetId !== controlTargetId
      || parsedOwnership.controlEpoch !== controlEpoch) {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned an inconsistent target resolution",
      );
    }
    return {
      controlTargetId,
      controlEpoch,
      managedSession: {
        name: requiredString(value.managedSession.name, "managedSession.name"),
        kind: managedKind,
        createdAt: canonicalTimestamp(value.managedSession.createdAt, "managedSession.createdAt"),
      },
      ownership: parsedOwnership,
    };
  }

  async ownershipStatus(controlTargetId: string): Promise<CanonicalTerminalOwnership> {
    return ownership(await this.request("ownership.status", { controlTargetId }));
  }

  async acquireLease(
    controlTargetId: string,
    leaseOwner: CanonicalTerminalOwner,
    ttlMs?: number,
  ): Promise<CanonicalLeaseResult> {
    return leaseResult(await this.request("lease.acquire", {
      controlTargetId,
      owner: leaseOwner,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }));
  }

  async renewLease(currentLease: CanonicalTerminalLease, ttlMs?: number): Promise<CanonicalLeaseResult> {
    return leaseResult(await this.request("lease.renew", {
      lease: currentLease,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }));
  }

  async releaseLease(currentLease: CanonicalTerminalLease): Promise<CanonicalTerminalOwnership> {
    return ownership(await this.request("lease.release", { lease: currentLease }));
  }

  async beginHandoff(
    controlTargetId: string,
    nextOwner: CanonicalTerminalOwner,
    currentLease?: CanonicalTerminalLease,
  ): Promise<CanonicalHandoffResult> {
    return handoffResult(await this.request("handoff.begin", {
      controlTargetId,
      nextOwner,
      ...(currentLease === undefined ? {} : { currentLease }),
    }));
  }

  async commitHandoff(
    handoffId: string,
    currentLease: CanonicalTerminalLease,
    drain: CanonicalDrainRecord,
    ttlMs?: number,
  ): Promise<CanonicalHandoffResult> {
    return handoffResult(await this.request("handoff.commit", {
      handoffId,
      currentLease,
      drain,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }));
  }

  async cancelHandoff(
    handoffId: string,
    currentLease: CanonicalTerminalLease,
  ): Promise<CanonicalTerminalOwnership> {
    return ownership(await this.request("handoff.cancel", { handoffId, currentLease }));
  }

  async withdrawHandoff(
    controlTargetId: string,
    handoffId: string,
    nextOwner: CanonicalTerminalOwner,
  ): Promise<CanonicalTerminalOwnership> {
    return ownership(await this.request("handoff.withdraw", {
      controlTargetId,
      handoffId,
      nextOwner,
    }));
  }

  async sendAgentMessage(input: {
    lease: CanonicalTerminalLease;
    operationId: string;
    pane: string;
    message: string;
    submit: boolean;
  }): Promise<CanonicalAgentMessageResult> {
    const value = await this.request("input.agent-message", input);
    if (!isRecord(value) || value.accepted !== true || typeof value.deduplicated !== "boolean") {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid agent-message result");
    }
    return {
      operationId: requiredString(value.operationId, "operationId"),
      accepted: true,
      deduplicated: value.deduplicated,
      controlEpoch: requiredString(value.controlEpoch, "controlEpoch"),
      fence: decimal(value.fence, "fence"),
      outputGeneration: requiredString(value.outputGeneration, "outputGeneration"),
      outputCursor: nonNegativeInteger(value.outputCursor, "outputCursor"),
    };
  }

  async tailOutput(input: {
    controlTargetId: string;
    controlEpoch: string;
    outputGeneration: string;
    cursor: number;
    maxBytes?: number;
  }): Promise<CanonicalOutputTailResult> {
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0
      || (input.maxBytes !== undefined
        && (!Number.isSafeInteger(input.maxBytes)
          || input.maxBytes < 1
          || input.maxBytes > CANONICAL_TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES))) {
      throw new CanonicalTerminalControlError(
        "INVALID_REQUEST",
        "canonical terminal-control output tail bounds are invalid",
      );
    }
    const value = await this.request("output.tail", input);
    if (!isRecord(value)) {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid output tail");
    }
    const dataBase64 = typeof value.dataBase64 === "string" ? value.dataBase64 : "";
    const data = Buffer.from(dataBase64, "base64");
    const maxBytes = input.maxBytes ?? CANONICAL_TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)
      || data.toString("base64") !== dataBase64
      || data.byteLength > maxBytes) {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned invalid output dataBase64");
    }
    const nextCursor = nonNegativeInteger(value.nextCursor, "nextCursor");
    if (nextCursor !== input.cursor + data.byteLength) {
      throw new CanonicalTerminalControlError("CONTROLLER_UNAVAILABLE", "canonical terminal-control returned an inconsistent output cursor");
    }
    const result: CanonicalOutputTailResult = {
      controlTargetId: requiredString(value.controlTargetId, "output.controlTargetId"),
      controlEpoch: requiredString(value.controlEpoch, "output.controlEpoch"),
      fence: decimal(value.fence, "output.fence"),
      ...(value.ownerKind === undefined ? {} : {
        ownerKind: requiredOwnerKind(value.ownerKind, "output.ownerKind"),
      }),
      outputGeneration: requiredString(value.outputGeneration, "output.outputGeneration"),
      cursor: nonNegativeInteger(value.cursor, "output.cursor"),
      dataBase64,
      nextCursor,
    };
    if (result.controlTargetId !== input.controlTargetId
      || result.controlEpoch !== input.controlEpoch
      || result.outputGeneration !== input.outputGeneration
      || result.cursor !== input.cursor) {
      throw new CanonicalTerminalControlError(
        "CONTROLLER_UNAVAILABLE",
        "canonical terminal-control returned mismatched output correlation",
      );
    }
    return result;
  }

  async renderedSnapshot(input: CanonicalRenderedSnapshotInput): Promise<CanonicalRenderedSnapshotResult> {
    validateRenderedSnapshotInput(input);
    return parseCanonicalRenderedSnapshotResult(
      await this.request("output.rendered-snapshot", input),
      input,
    );
  }

  private request(type: string, fields: Record<string, unknown>): Promise<unknown> {
    const input = {
      type,
      ...fields,
    } as TerminalControlRequestInput;
    return requestTerminalControl(input, {
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
    });
  }
}
