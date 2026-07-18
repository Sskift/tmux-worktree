import type {
  TerminalControlLease,
  TerminalControlOwner,
  TerminalControlOwnershipView,
} from "../../terminalControl/protocol.js";
import {
  TERMINAL_CONTROL_MAX_INPUT_BYTES,
  TerminalControlProtocolError,
} from "../../terminalControl/protocol.js";
import type { TerminalControlRequestInput } from "../../terminalControl/client.js";
import type {
  RelayV2TerminalAuthorityInput,
  RelayV2TerminalAuthorityResize,
  RelayV2TerminalAuthorityResult,
  RelayV2TerminalControlAuthority,
  RelayV2TerminalLeaseResult,
  RelayV2TerminalResolvedTarget,
  RelayV2TerminalStructuredError,
} from "./terminalManager.js";

const MAX_V2_TERMINAL_BYTES = 64 * 1024;
const MAX_V2_ID_BYTES = 128;

/**
 * One correlated, bounded local terminal-control request. Implementations must
 * not retry or auto-start the authority. A TerminalControlProtocolError is the
 * only definite rejection signal; every other rejection is transport-uncertain.
 */
export interface RelayV2TerminalControlRequestPort {
  request<T = unknown>(input: TerminalControlRequestInput): Promise<T>;
}

type AuthorityFailure = {
  uncertain: boolean;
  error: RelayV2TerminalStructuredError;
};

const TERMINAL_CONTROL_ERROR_CODES = new Set([
  "INVALID_REQUEST",
  "UNSUPPORTED_VERSION",
  "TARGET_NOT_FOUND",
  "TARGET_GONE",
  "PERMISSION_DENIED",
  "HANDOFF_PENDING",
  "RECOVERY_REQUIRED",
  "STALE_OUTPUT_CURSOR",
  "OPERATION_IN_DOUBT",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
]);

class AdapterInputError extends Error {
  constructor(readonly code: "PERMISSION_DENIED" | "INTERNAL") {
    super("Relay v2 terminal-control adapter input is invalid");
    this.name = "AdapterInputError";
  }
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

function boundedId(value: unknown, maxBytes = MAX_V2_ID_BYTES): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new AdapterInputError("INTERNAL");
  }
  return value;
}

function boundedProtocolString(value: unknown, maxCharacters: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxCharacters
    || /[\0\r\n]/.test(value)
  ) {
    throw new AdapterInputError("INTERNAL");
  }
  return value;
}

function decimal(value: unknown): string {
  const parsed = boundedProtocolString(value, 32);
  if (!/^(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new AdapterInputError("INTERNAL");
  }
  return parsed;
}

function timestamp(value: unknown): string {
  const parsed = boundedProtocolString(value, 64);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new AdapterInputError("INTERNAL");
  }
  return parsed;
}

function owner(value: unknown): TerminalControlOwner {
  if (!isRecord(value) || !exactKeys(value, ["kind", "instanceId"])) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.kind !== "relay-v2") {
    throw new AdapterInputError("PERMISSION_DENIED");
  }
  return {
    kind: "relay-v2",
    instanceId: boundedProtocolString(value.instanceId, 256),
  };
}

function sameOwner(left: TerminalControlOwner, right: TerminalControlOwner): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

function lease(value: unknown): TerminalControlLease {
  if (!isRecord(value) || !exactKeys(value, [
    "controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt",
  ])) {
    throw new AdapterInputError("INTERNAL");
  }
  return {
    controlTargetId: boundedProtocolString(value.controlTargetId, 128),
    controlEpoch: boundedProtocolString(value.controlEpoch, 128),
    leaseId: boundedProtocolString(value.leaseId, 128),
    fence: decimal(value.fence),
    owner: owner(value.owner),
    expiresAt: timestamp(value.expiresAt),
  };
}

function copyLease(value: TerminalControlLease): TerminalControlLease {
  return { ...value, owner: { ...value.owner } };
}

function target(value: unknown): RelayV2TerminalResolvedTarget {
  if (!isRecord(value) || !exactKeys(value, [
    "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
  ])) {
    throw new AdapterInputError("INTERNAL");
  }
  if (!Number.isSafeInteger(value.pane) || (value.pane as number) < 0 || (value.pane as number) > 65_535) {
    throw new AdapterInputError("INTERNAL");
  }
  return {
    hostId: boundedId(value.hostId),
    scopeId: boundedId(value.scopeId),
    sessionId: boundedId(value.sessionId),
    pane: value.pane as number,
    canonicalTargetId: boundedId(value.canonicalTargetId),
    controlTargetId: boundedProtocolString(value.controlTargetId, 128),
  };
}

function auth(value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, ["principalId", "clientInstanceId"])) {
    throw new AdapterInputError("INTERNAL");
  }
  boundedId(value.principalId);
  boundedId(value.clientInstanceId);
}

function operationId(value: unknown): string {
  return boundedProtocolString(value, 192);
}

function binding(input: {
  target: unknown;
  auth: unknown;
  owner: unknown;
  lease: unknown;
}): {
  target: RelayV2TerminalResolvedTarget;
  owner: TerminalControlOwner;
  lease: TerminalControlLease;
} {
  const parsedTarget = target(input.target);
  auth(input.auth);
  const parsedOwner = owner(input.owner);
  const parsedLease = lease(input.lease);
  if (
    parsedLease.controlTargetId !== parsedTarget.controlTargetId
    || !sameOwner(parsedLease.owner, parsedOwner)
  ) {
    throw new AdapterInputError("PERMISSION_DENIED");
  }
  return { target: parsedTarget, owner: parsedOwner, lease: parsedLease };
}

const OWNER_KINDS = new Set([
  "feishu", "dashboard", "local-cli", "relay-v1", "relay-v2", "tw-serve",
]);

function ownership(value: unknown): TerminalControlOwnershipView {
  if (!isRecord(value) || !exactKeys(value, [
    "controlTargetId", "controlEpoch", "state", "fence",
    "outputGeneration", "outputCursor", "revision",
  ], ["ownerKind", "nextOwnerKind", "handoffId", "leaseExpiresAt"])) {
    throw new AdapterInputError("INTERNAL");
  }
  if (!["FREE", "HELD", "DRAINING", "RECOVERY_REQUIRED", "TARGET_GONE"].includes(value.state as string)) {
    throw new AdapterInputError("INTERNAL");
  }
  if (!Number.isSafeInteger(value.outputCursor) || (value.outputCursor as number) < 0) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.ownerKind !== undefined && !OWNER_KINDS.has(value.ownerKind as string)) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.nextOwnerKind !== undefined && !OWNER_KINDS.has(value.nextOwnerKind as string)) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.state === "HELD" && (value.ownerKind === undefined || value.leaseExpiresAt === undefined)) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.state === "DRAINING" && (
    value.ownerKind === undefined
    || value.nextOwnerKind === undefined
    || value.handoffId === undefined
    || value.leaseExpiresAt === undefined
  )) {
    throw new AdapterInputError("INTERNAL");
  }
  if (value.leaseExpiresAt !== undefined) timestamp(value.leaseExpiresAt);
  if (value.handoffId !== undefined) boundedProtocolString(value.handoffId, 128);
  return {
    controlTargetId: boundedProtocolString(value.controlTargetId, 128),
    controlEpoch: boundedProtocolString(value.controlEpoch, 128),
    state: value.state as TerminalControlOwnershipView["state"],
    fence: decimal(value.fence),
    ...(value.ownerKind === undefined
      ? {}
      : { ownerKind: value.ownerKind as TerminalControlOwner["kind"] }),
    ...(value.nextOwnerKind === undefined
      ? {}
      : { nextOwnerKind: value.nextOwnerKind as TerminalControlOwner["kind"] }),
    ...(value.handoffId === undefined ? {} : { handoffId: value.handoffId as string }),
    ...(value.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: value.leaseExpiresAt as string }),
    outputGeneration: boundedProtocolString(value.outputGeneration, 128),
    outputCursor: value.outputCursor as number,
    revision: decimal(value.revision),
  };
}

function ownershipMatchesLease(
  view: TerminalControlOwnershipView,
  expectedTarget: RelayV2TerminalResolvedTarget,
  expectedLease: TerminalControlLease,
): boolean {
  return view.controlTargetId === expectedTarget.controlTargetId
    && view.controlEpoch === expectedLease.controlEpoch
    && view.fence === expectedLease.fence
    && view.state === "HELD"
    && view.ownerKind !== undefined
    && view.ownerKind !== "feishu";
}

function leaseEnvelope(
  value: unknown,
  expectedTarget: RelayV2TerminalResolvedTarget,
  expectedOwner: TerminalControlOwner,
  current?: TerminalControlLease,
): TerminalControlLease {
  if (!isRecord(value) || !exactKeys(value, ["lease", "ownership"])) {
    throw new AdapterInputError("INTERNAL");
  }
  const parsedLease = lease(value.lease);
  const parsedOwnership = ownership(value.ownership);
  if (
    parsedLease.controlTargetId !== expectedTarget.controlTargetId
    || !sameOwner(parsedLease.owner, expectedOwner)
    || !ownershipMatchesLease(parsedOwnership, expectedTarget, parsedLease)
    || parsedOwnership.leaseExpiresAt !== parsedLease.expiresAt
    || (current !== undefined && (
      parsedLease.controlTargetId !== current.controlTargetId
      || parsedLease.controlEpoch !== current.controlEpoch
      || parsedLease.leaseId !== current.leaseId
      || parsedLease.fence !== current.fence
      || !sameOwner(parsedLease.owner, current.owner)
    ))
  ) {
    throw new AdapterInputError("PERMISSION_DENIED");
  }
  return parsedLease;
}

function operationResult(
  value: unknown,
  expectedOperationId: string,
  expectedLease: TerminalControlLease,
): void {
  if (!isRecord(value) || !exactKeys(value, [
    "operationId", "accepted", "deduplicated", "controlEpoch", "fence",
    "outputGeneration", "outputCursor",
  ])) {
    throw new AdapterInputError("INTERNAL");
  }
  if (
    value.operationId !== expectedOperationId
    || value.accepted !== true
    || typeof value.deduplicated !== "boolean"
    || value.controlEpoch !== expectedLease.controlEpoch
    || value.fence !== expectedLease.fence
    || !Number.isSafeInteger(value.outputCursor)
    || (value.outputCursor as number) < 0
  ) {
    throw new AdapterInputError("PERMISSION_DENIED");
  }
  boundedProtocolString(value.outputGeneration, 128);
}

function structuredError(
  code: RelayV2TerminalStructuredError["code"],
  message: string,
  retryable: boolean,
  commandDisposition: "not_applicable" | "in_doubt" = "not_applicable",
): RelayV2TerminalStructuredError {
  return { code, message, retryable, details: null, commandDisposition };
}

function localFailure(error: unknown): AuthorityFailure {
  const code = error instanceof AdapterInputError ? error.code : "INTERNAL";
  return {
    uncertain: false,
    error: structuredError(
      code,
      code === "PERMISSION_DENIED"
        ? "Terminal input authority binding does not match the requested target"
        : "Terminal input authority request is invalid",
      false,
    ),
  };
}

function protocolFailure(error: unknown): {
  code: TerminalControlProtocolError["code"];
  retryable: boolean;
} | undefined {
  if (error instanceof TerminalControlProtocolError) {
    return { code: error.code, retryable: error.retryable };
  }
  // The root ESM build has independent entry bundles. Preserve the explicit
  // request-port rejection contract across those bundle identities without
  // treating ordinary errno/timeout errors as authority rejections.
  if (!isRecord(error)
    || error.name !== "TerminalControlProtocolError"
    || typeof error.code !== "string"
    || !TERMINAL_CONTROL_ERROR_CODES.has(error.code)
    || typeof error.retryable !== "boolean") {
    return undefined;
  }
  return {
    code: error.code as TerminalControlProtocolError["code"],
    retryable: error.retryable,
  };
}

function authorityFailure(error: unknown): AuthorityFailure {
  const protocol = protocolFailure(error);
  if (!protocol
    || protocol.code === "OPERATION_IN_DOUBT"
    || protocol.code === "INTERNAL") {
    return {
      uncertain: true,
      error: structuredError(
        "COMMAND_IN_DOUBT",
        "Terminal input authority outcome could not be confirmed",
        false,
        "in_doubt",
      ),
    };
  }
  if (protocol.code === "RESOURCE_EXHAUSTED") {
    return {
      uncertain: false,
      error: structuredError(
        "BUSY",
        "Terminal input authority is at capacity",
        true,
      ),
    };
  }
  if (protocol.code === "TARGET_NOT_FOUND" || protocol.code === "TARGET_GONE") {
    return {
      uncertain: false,
      error: structuredError(
        "SESSION_NOT_FOUND",
        "Terminal input target is no longer authoritative",
        false,
      ),
    };
  }
  if (
    protocol.code === "PERMISSION_DENIED"
    || protocol.code === "HANDOFF_PENDING"
    || protocol.code === "RECOVERY_REQUIRED"
  ) {
    return {
      uncertain: false,
      error: structuredError(
        "PERMISSION_DENIED",
        "Terminal input authority rejected the current lease",
        protocol.retryable || protocol.code !== "PERMISSION_DENIED",
      ),
    };
  }
  return {
    uncertain: false,
    error: structuredError(
      "INTERNAL",
      "Terminal input authority rejected the request",
      false,
    ),
  };
}

function uncertainSuccess(): AuthorityFailure {
  return {
    uncertain: true,
    error: structuredError(
      "COMMAND_IN_DOUBT",
      "Terminal input authority returned an unprovable result",
      false,
      "in_doubt",
    ),
  };
}

function leaseFailure(failure: AuthorityFailure): RelayV2TerminalLeaseResult {
  return failure.uncertain
    ? { status: "uncertain", error: failure.error }
    : { status: "rejected", error: failure.error };
}

function authorityResult(failure: AuthorityFailure): RelayV2TerminalAuthorityResult {
  return { accepted: false, uncertain: failure.uncertain, error: failure.error };
}

function throwFailure(failure: AuthorityFailure): never {
  if (failure.uncertain) {
    throw new TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      failure.error.message,
      false,
    );
  }
  if (failure.error.code === "BUSY") {
    throw new TerminalControlProtocolError(
      "RESOURCE_EXHAUSTED",
      failure.error.message,
      true,
    );
  }
  throw new TerminalControlProtocolError(
    "PERMISSION_DENIED",
    failure.error.message,
    failure.error.retryable,
  );
}

/**
 * Unwired H3-C1 translator. TerminalControlAuthority remains the only lease,
 * operation and backend-write owner; this class retains no parallel facts.
 */
export class RelayV2TerminalControlAuthorityAdapter implements RelayV2TerminalControlAuthority {
  constructor(private readonly requestPort: RelayV2TerminalControlRequestPort) {
    if (!requestPort || typeof requestPort.request !== "function") {
      throw new TypeError("Relay v2 terminal-control request port is required");
    }
  }

  async acquire(input: Parameters<RelayV2TerminalControlAuthority["acquire"]>[0]): Promise<RelayV2TerminalLeaseResult> {
    let parsedTarget: RelayV2TerminalResolvedTarget;
    let parsedOwner: TerminalControlOwner;
    try {
      parsedTarget = target(input.target);
      auth(input.auth);
      parsedOwner = owner(input.owner);
    } catch (error) {
      return leaseFailure(localFailure(error));
    }
    try {
      const result = await this.requestPort.request({
        type: "lease.acquire",
        controlTargetId: parsedTarget.controlTargetId,
        owner: { ...parsedOwner },
      });
      const acceptedLease = leaseEnvelope(result, parsedTarget, parsedOwner);
      return { status: "accepted", lease: copyLease(acceptedLease) };
    } catch (error) {
      return leaseFailure(
        error instanceof AdapterInputError ? uncertainSuccess() : authorityFailure(error),
      );
    }
  }

  async renew(input: Parameters<RelayV2TerminalControlAuthority["renew"]>[0]): Promise<RelayV2TerminalLeaseResult> {
    let parsed: ReturnType<typeof binding>;
    try {
      parsed = binding(input);
    } catch (error) {
      return leaseFailure(localFailure(error));
    }
    try {
      const result = await this.requestPort.request({
        type: "lease.renew",
        lease: copyLease(parsed.lease),
      });
      const renewed = leaseEnvelope(result, parsed.target, parsed.owner, parsed.lease);
      return { status: "accepted", lease: copyLease(renewed) };
    } catch (error) {
      return leaseFailure(
        error instanceof AdapterInputError ? uncertainSuccess() : authorityFailure(error),
      );
    }
  }

  async release(input: Parameters<RelayV2TerminalControlAuthority["release"]>[0]): Promise<void> {
    let parsed: ReturnType<typeof binding>;
    try {
      parsed = binding(input);
    } catch (error) {
      throwFailure(localFailure(error));
    }
    let result: unknown;
    try {
      result = await this.requestPort.request({
        type: "lease.release",
        lease: copyLease(parsed.lease),
      });
    } catch (error) {
      throwFailure(authorityFailure(error));
    }
    try {
      const view = ownership(result);
      const fence = BigInt(view.fence);
      const previousFence = BigInt(parsed.lease.fence);
      const heldByInteractive = view.state === "HELD"
        && view.ownerKind !== undefined
        && view.ownerKind !== "feishu"
        && fence === previousFence;
      const releasedToFree = view.state === "FREE" && fence > previousFence;
      if (
        view.controlTargetId !== parsed.target.controlTargetId
        || view.controlEpoch !== parsed.lease.controlEpoch
        || (!heldByInteractive && !releasedToFree)
      ) {
        throw new AdapterInputError("PERMISSION_DENIED");
      }
    } catch {
      throwFailure(uncertainSuccess());
    }
  }

  async hasContinuity(input: Parameters<RelayV2TerminalControlAuthority["hasContinuity"]>[0]): Promise<boolean> {
    let parsed: ReturnType<typeof binding>;
    try {
      parsed = binding(input);
    } catch (error) {
      throwFailure(localFailure(error));
    }
    let result: unknown;
    try {
      result = await this.requestPort.request({
        type: "ownership.status",
        controlTargetId: parsed.target.controlTargetId,
      });
    } catch (error) {
      throwFailure(authorityFailure(error));
    }
    try {
      const view = ownership(result);
      return ownershipMatchesLease(view, parsed.target, parsed.lease);
    } catch {
      throwFailure(uncertainSuccess());
    }
  }

  async writeInput(input: RelayV2TerminalAuthorityInput): Promise<RelayV2TerminalAuthorityResult> {
    let parsed: ReturnType<typeof binding>;
    let parsedOperationId: string;
    let data: Buffer;
    try {
      parsed = binding(input);
      parsedOperationId = operationId(input.operationId);
      if (!(input.data instanceof Uint8Array)
        || input.data.byteLength > MAX_V2_TERMINAL_BYTES
        || input.data.byteLength > TERMINAL_CONTROL_MAX_INPUT_BYTES) {
        throw new AdapterInputError("INTERNAL");
      }
      data = Buffer.from(input.data);
    } catch (error) {
      return authorityResult(localFailure(error));
    }
    try {
      const result = await this.requestPort.request({
        type: "input.raw",
        lease: copyLease(parsed.lease),
        operationId: parsedOperationId,
        pane: String(parsed.target.pane),
        dataBase64: data.toString("base64"),
      });
      operationResult(result, parsedOperationId, parsed.lease);
      return { accepted: true };
    } catch (error) {
      return authorityResult(
        error instanceof AdapterInputError ? uncertainSuccess() : authorityFailure(error),
      );
    }
  }

  async resize(input: RelayV2TerminalAuthorityResize): Promise<RelayV2TerminalAuthorityResult> {
    let parsed: ReturnType<typeof binding>;
    let parsedOperationId: string;
    try {
      parsed = binding(input);
      parsedOperationId = operationId(input.operationId);
      if (!Number.isSafeInteger(input.cols)
        || !Number.isSafeInteger(input.rows)
        || input.cols < 1
        || input.cols > 1000
        || input.rows < 1
        || input.rows > 500) {
        throw new AdapterInputError("INTERNAL");
      }
    } catch (error) {
      return authorityResult(localFailure(error));
    }
    try {
      const result = await this.requestPort.request({
        type: "input.resize",
        lease: copyLease(parsed.lease),
        operationId: parsedOperationId,
        pane: String(parsed.target.pane),
        cols: input.cols,
        rows: input.rows,
      });
      operationResult(result, parsedOperationId, parsed.lease);
      return { accepted: true };
    } catch (error) {
      return authorityResult(
        error instanceof AdapterInputError ? uncertainSuccess() : authorityFailure(error),
      );
    }
  }
}
