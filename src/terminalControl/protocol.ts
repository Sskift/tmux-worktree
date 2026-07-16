export const TERMINAL_CONTROL_PROTOCOL_VERSION = 1 as const;

export const TERMINAL_CONTROL_MAX_FRAME_BYTES = 384 * 1024;
export const TERMINAL_CONTROL_MAX_INPUT_BYTES = 256 * 1024;
export const TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES = 256 * 1024;
export const TERMINAL_CONTROL_OUTPUT_RETAINED_MIN_BYTES = 4 * 1024 * 1024;
export const TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS = 60_000;
export const TERMINAL_CONTROL_MIN_LEASE_TTL_MS = 5_000;
export const TERMINAL_CONTROL_MAX_LEASE_TTL_MS = 5 * 60_000;
export const TERMINAL_CONTROL_RENEW_INTERVAL_MS = 20_000;

export type TerminalControlOwnerKind =
  | "feishu"
  | "dashboard"
  | "local-cli"
  | "relay-v1"
  | "relay-v2"
  | "tw-serve";

export interface TerminalControlOwner {
  kind: TerminalControlOwnerKind;
  instanceId: string;
}

export interface TerminalControlLease {
  controlTargetId: string;
  controlEpoch: string;
  leaseId: string;
  fence: string;
  owner: TerminalControlOwner;
  expiresAt: string;
}

export interface TerminalControlDrainProof {
  disposition: "drained" | "cancelled" | "uncertain";
  recordId: string;
  recordedAt: string;
}

export interface TerminalControlRecoveryProof {
  kind: "feishu-turn-cancelled" | "operator-acknowledged-in-doubt" | "owner-unreachable";
  recordId: string;
  recordedAt: string;
}

export interface TerminalControlRequestBase {
  protocolVersion: typeof TERMINAL_CONTROL_PROTOCOL_VERSION;
  requestId: string;
}

export type TerminalControlRequest =
  | (TerminalControlRequestBase & {
      type: "ping";
    })
  | (TerminalControlRequestBase & {
      type: "target.resolve";
      sessionName: string;
    })
  | (TerminalControlRequestBase & {
      type: "ownership.status";
      controlTargetId: string;
    })
  | (TerminalControlRequestBase & {
      type: "lease.acquire";
      controlTargetId: string;
      owner: TerminalControlOwner;
      ttlMs?: number;
    })
  | (TerminalControlRequestBase & {
      type: "lease.renew";
      lease: TerminalControlLease;
      ttlMs?: number;
    })
  | (TerminalControlRequestBase & {
      type: "lease.release";
      lease: TerminalControlLease;
    })
  | (TerminalControlRequestBase & {
      type: "handoff.begin";
      controlTargetId: string;
      nextOwner: TerminalControlOwner;
      currentLease?: TerminalControlLease;
    })
  | (TerminalControlRequestBase & {
      type: "handoff.commit";
      handoffId: string;
      currentLease: TerminalControlLease;
      drain: TerminalControlDrainProof;
      ttlMs?: number;
    })
  | (TerminalControlRequestBase & {
      type: "handoff.cancel";
      handoffId: string;
      currentLease: TerminalControlLease;
    })
  | (TerminalControlRequestBase & {
      type: "handoff.withdraw";
      controlTargetId: string;
      handoffId: string;
      nextOwner: TerminalControlOwner;
    })
  | (TerminalControlRequestBase & {
      type: "handoff.force";
      controlTargetId: string;
      expectedControlEpoch: string;
      nextOwner: TerminalControlOwner;
      proof: TerminalControlRecoveryProof;
      acknowledgeUncertainOperation: boolean;
      ttlMs?: number;
    })
  | (TerminalControlRequestBase & {
      type: "input.raw";
      lease: TerminalControlLease;
      operationId: string;
      pane: string;
      dataBase64: string;
    })
  | (TerminalControlRequestBase & {
      type: "input.agent-message";
      lease: TerminalControlLease;
      operationId: string;
      pane: string;
      message: string;
      submit: boolean;
    })
  | (TerminalControlRequestBase & {
      type: "input.resize";
      lease: TerminalControlLease;
      operationId: string;
      pane: string;
      cols: number;
      rows: number;
    })
  | (TerminalControlRequestBase & {
      type: "input.scroll";
      lease: TerminalControlLease;
      operationId: string;
      pane: string;
      direction: "up" | "down";
      lines: number;
    })
  | (TerminalControlRequestBase & {
      type: "lifecycle.kill";
      lease: TerminalControlLease;
      operationId: string;
    })
  | (TerminalControlRequestBase & {
      type: "output.tail";
      controlTargetId: string;
      controlEpoch: string;
      outputGeneration: string;
      cursor: number;
      maxBytes?: number;
    });

export type TerminalControlErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_VERSION"
  | "TARGET_NOT_FOUND"
  | "TARGET_GONE"
  | "PERMISSION_DENIED"
  | "HANDOFF_PENDING"
  | "RECOVERY_REQUIRED"
  | "STALE_OUTPUT_CURSOR"
  | "OPERATION_IN_DOUBT"
  | "RESOURCE_EXHAUSTED"
  | "INTERNAL";

export interface TerminalControlError {
  code: TerminalControlErrorCode;
  message: string;
  retryable: boolean;
}

export type TerminalControlResponse =
  | {
      protocolVersion: typeof TERMINAL_CONTROL_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: typeof TERMINAL_CONTROL_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: TerminalControlError;
    };

export type TerminalControlOwnershipView = {
  controlTargetId: string;
  controlEpoch: string;
  state: "FREE" | "HELD" | "DRAINING" | "RECOVERY_REQUIRED" | "TARGET_GONE";
  fence: string;
  ownerKind?: TerminalControlOwnerKind;
  nextOwnerKind?: TerminalControlOwnerKind;
  handoffId?: string;
  leaseExpiresAt?: string;
  outputGeneration: string;
  outputCursor: number;
  revision: string;
};

export class TerminalControlProtocolError extends Error {
  readonly code: TerminalControlErrorCode;
  readonly retryable: boolean;

  constructor(code: TerminalControlErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "TerminalControlProtocolError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function boundedString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", `${field} is invalid`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", `${field} contains a forbidden control character`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const parsed = boundedString(value, field, 64);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", `${field} is invalid`);
  }
  return parsed;
}

function optionalTtl(value: unknown, field = "ttlMs"): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value)
    || (value as number) < TERMINAL_CONTROL_MIN_LEASE_TTL_MS
    || (value as number) > TERMINAL_CONTROL_MAX_LEASE_TTL_MS
  ) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      `${field} must be between ${TERMINAL_CONTROL_MIN_LEASE_TTL_MS} and ${TERMINAL_CONTROL_MAX_LEASE_TTL_MS}`,
    );
  }
  return value as number;
}

function owner(value: unknown): TerminalControlOwner {
  if (!isRecord(value) || !exactKeys(value, ["kind", "instanceId"])) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "owner is invalid");
  }
  const kinds: TerminalControlOwnerKind[] = [
    "feishu",
    "dashboard",
    "local-cli",
    "relay-v1",
    "relay-v2",
    "tw-serve",
  ];
  if (!kinds.includes(value.kind as TerminalControlOwnerKind)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "owner.kind is invalid");
  }
  return {
    kind: value.kind as TerminalControlOwnerKind,
    instanceId: boundedString(value.instanceId, "owner.instanceId", 256),
  };
}

function lease(value: unknown): TerminalControlLease {
  if (!isRecord(value) || !exactKeys(value, ["controlTargetId", "controlEpoch", "leaseId", "fence", "owner", "expiresAt"])) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "lease is invalid");
  }
  const fence = boundedString(value.fence, "lease.fence", 32);
  if (!/^(?:0|[1-9]\d*)$/.test(fence)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "lease.fence is invalid");
  }
  return {
    controlTargetId: boundedString(value.controlTargetId, "lease.controlTargetId", 128),
    controlEpoch: boundedString(value.controlEpoch, "lease.controlEpoch", 128),
    leaseId: boundedString(value.leaseId, "lease.leaseId", 128),
    fence,
    owner: owner(value.owner),
    expiresAt: timestamp(value.expiresAt, "lease.expiresAt"),
  };
}

function drainProof(value: unknown): TerminalControlDrainProof {
  if (!isRecord(value) || !exactKeys(value, ["disposition", "recordId", "recordedAt"])) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "drain proof is invalid");
  }
  if (value.disposition !== "drained" && value.disposition !== "cancelled" && value.disposition !== "uncertain") {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "drain.disposition is invalid");
  }
  return {
    disposition: value.disposition,
    recordId: boundedString(value.recordId, "drain.recordId", 192),
    recordedAt: timestamp(value.recordedAt, "drain.recordedAt"),
  };
}

function recoveryProof(value: unknown): TerminalControlRecoveryProof {
  if (!isRecord(value) || !exactKeys(value, ["kind", "recordId", "recordedAt"])) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "recovery proof is invalid");
  }
  if (
    value.kind !== "feishu-turn-cancelled"
    && value.kind !== "operator-acknowledged-in-doubt"
    && value.kind !== "owner-unreachable"
  ) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "proof.kind is invalid");
  }
  return {
    kind: value.kind,
    recordId: boundedString(value.recordId, "proof.recordId", 192),
    recordedAt: timestamp(value.recordedAt, "proof.recordedAt"),
  };
}

function common(value: unknown): { record: Record<string, unknown>; requestId: string; type: string } {
  if (!isRecord(value)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "request must be an object");
  }
  if (value.protocolVersion !== TERMINAL_CONTROL_PROTOCOL_VERSION) {
    throw new TerminalControlProtocolError("UNSUPPORTED_VERSION", "unsupported terminal-control protocolVersion");
  }
  return {
    record: value,
    requestId: boundedString(value.requestId, "requestId", 128),
    type: boundedString(value.type, "type", 64),
  };
}

function pane(value: unknown): string {
  const parsed = boundedString(value, "pane", 8);
  if (!/^(?:0|[1-9]\d{0,4})$/.test(parsed)) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "pane is invalid");
  }
  return parsed;
}

export function parseTerminalControlRequest(value: unknown): TerminalControlRequest {
  const { record, requestId, type } = common(value);
  const base = { protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION, requestId } as const;
  switch (type) {
    case "ping":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type"])) break;
      return { ...base, type };
    case "target.resolve":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "sessionName"])) break;
      return { ...base, type, sessionName: boundedString(record.sessionName, "sessionName", 128) };
    case "ownership.status":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId"])) break;
      return { ...base, type, controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128) };
    case "lease.acquire":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId", "owner"], ["ttlMs"])) break;
      return {
        ...base,
        type,
        controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128),
        owner: owner(record.owner),
        ...(record.ttlMs === undefined ? {} : { ttlMs: optionalTtl(record.ttlMs) }),
      };
    case "lease.renew":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease"], ["ttlMs"])) break;
      return {
        ...base,
        type,
        lease: lease(record.lease),
        ...(record.ttlMs === undefined ? {} : { ttlMs: optionalTtl(record.ttlMs) }),
      };
    case "lease.release":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease"])) break;
      return { ...base, type, lease: lease(record.lease) };
    case "handoff.begin":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId", "nextOwner"], ["currentLease"])) break;
      return {
        ...base,
        type,
        controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128),
        nextOwner: owner(record.nextOwner),
        ...(record.currentLease === undefined ? {} : { currentLease: lease(record.currentLease) }),
      };
    case "handoff.commit":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "handoffId", "currentLease", "drain"], ["ttlMs"])) break;
      return {
        ...base,
        type,
        handoffId: boundedString(record.handoffId, "handoffId", 128),
        currentLease: lease(record.currentLease),
        drain: drainProof(record.drain),
        ...(record.ttlMs === undefined ? {} : { ttlMs: optionalTtl(record.ttlMs) }),
      };
    case "handoff.cancel":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "handoffId", "currentLease"])) break;
      return {
        ...base,
        type,
        handoffId: boundedString(record.handoffId, "handoffId", 128),
        currentLease: lease(record.currentLease),
      };
    case "handoff.withdraw":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId", "handoffId", "nextOwner"])) break;
      return {
        ...base,
        type,
        controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128),
        handoffId: boundedString(record.handoffId, "handoffId", 128),
        nextOwner: owner(record.nextOwner),
      };
    case "handoff.force":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId", "expectedControlEpoch", "nextOwner", "proof", "acknowledgeUncertainOperation"], ["ttlMs"])) break;
      if (record.acknowledgeUncertainOperation !== true) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "force handoff requires acknowledgeUncertainOperation=true");
      }
      return {
        ...base,
        type,
        controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128),
        expectedControlEpoch: boundedString(record.expectedControlEpoch, "expectedControlEpoch", 128),
        nextOwner: owner(record.nextOwner),
        proof: recoveryProof(record.proof),
        acknowledgeUncertainOperation: true,
        ...(record.ttlMs === undefined ? {} : { ttlMs: optionalTtl(record.ttlMs) }),
      };
    case "input.raw": {
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease", "operationId", "pane", "dataBase64"])) break;
      const dataBase64 = boundedString(record.dataBase64, "dataBase64", TERMINAL_CONTROL_MAX_INPUT_BYTES * 2, true);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "dataBase64 is invalid");
      }
      const data = Buffer.from(dataBase64, "base64");
      if (data.byteLength > TERMINAL_CONTROL_MAX_INPUT_BYTES || data.toString("base64") !== dataBase64) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "dataBase64 is invalid or too large");
      }
      return {
        ...base,
        type,
        lease: lease(record.lease),
        operationId: boundedString(record.operationId, "operationId", 192),
        pane: pane(record.pane),
        dataBase64,
      };
    }
    case "input.agent-message":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease", "operationId", "pane", "message", "submit"])) break;
      if (typeof record.message !== "string" || Buffer.byteLength(record.message, "utf8") > TERMINAL_CONTROL_MAX_INPUT_BYTES) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "message is invalid or too large");
      }
      if (record.submit !== true && record.submit !== false) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "submit must be boolean");
      }
      return {
        ...base,
        type,
        lease: lease(record.lease),
        operationId: boundedString(record.operationId, "operationId", 192),
        pane: pane(record.pane),
        message: record.message,
        submit: record.submit,
      };
    case "input.resize":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease", "operationId", "pane", "cols", "rows"])) break;
      if (!Number.isSafeInteger(record.cols) || !Number.isSafeInteger(record.rows)) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "cols and rows must be integers");
      }
      if ((record.cols as number) < 20 || (record.cols as number) > 300 || (record.rows as number) < 5 || (record.rows as number) > 200) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "terminal size is out of range");
      }
      return {
        ...base,
        type,
        lease: lease(record.lease),
        operationId: boundedString(record.operationId, "operationId", 192),
        pane: pane(record.pane),
        cols: record.cols as number,
        rows: record.rows as number,
      };
    case "input.scroll":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease", "operationId", "pane", "direction", "lines"])) break;
      if (record.direction !== "up" && record.direction !== "down") {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "scroll direction must be up or down");
      }
      if (!Number.isSafeInteger(record.lines) || (record.lines as number) < 1 || (record.lines as number) > 100) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "scroll lines must be an integer from 1 to 100");
      }
      return {
        ...base,
        type,
        lease: lease(record.lease),
        operationId: boundedString(record.operationId, "operationId", 192),
        pane: pane(record.pane),
        direction: record.direction,
        lines: record.lines as number,
      };
    case "lifecycle.kill":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "lease", "operationId"])) break;
      return {
        ...base,
        type,
        lease: lease(record.lease),
        operationId: boundedString(record.operationId, "operationId", 192),
      };
    case "output.tail":
      if (!exactKeys(record, ["protocolVersion", "requestId", "type", "controlTargetId", "controlEpoch", "outputGeneration", "cursor"], ["maxBytes"])) break;
      if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "cursor is invalid");
      }
      if (
        record.maxBytes !== undefined
        && (
          !Number.isSafeInteger(record.maxBytes)
          || (record.maxBytes as number) < 1
          || (record.maxBytes as number) > TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES
        )
      ) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "maxBytes is invalid");
      }
      return {
        ...base,
        type,
        controlTargetId: boundedString(record.controlTargetId, "controlTargetId", 128),
        controlEpoch: boundedString(record.controlEpoch, "controlEpoch", 128),
        outputGeneration: boundedString(record.outputGeneration, "outputGeneration", 128),
        cursor: record.cursor as number,
        ...(record.maxBytes === undefined ? {} : { maxBytes: record.maxBytes as number }),
      };
  }
  throw new TerminalControlProtocolError("INVALID_REQUEST", `invalid or unknown request type: ${type}`);
}

export function terminalControlErrorResponse(
  requestId: string,
  error: unknown,
): TerminalControlResponse {
  const protocolError = error instanceof TerminalControlProtocolError
    ? error
    : new TerminalControlProtocolError(
        "INTERNAL",
        error instanceof Error ? error.message : String(error),
      );
  return {
    protocolVersion: TERMINAL_CONTROL_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: protocolError.code,
      message: protocolError.message,
      retryable: protocolError.retryable,
    },
  };
}
