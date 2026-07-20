import type { MobileRelayV2ProductAdapter } from "./dashboardBackend";
import type { MobileRelayV2DashboardState } from "./domainTypes";
import { MobileRelayV2BackendOperationError } from "./relayV2Domain";

const COMMAND = "mobile_relay_v2_management_call";
const REQUEST_ID_PATTERN = /^dmgmt1\.[A-Za-z0-9_-]{21}[AQgw]$/;
const DEFAULT_OFF_REASON = "Relay v2 management is unavailable (default off).";

const MANAGEMENT_ERRORS = {
  UNAVAILABLE: {
    code: "UNAVAILABLE",
    message: "Relay v2 management is unavailable",
    retryable: false,
  },
  CHANNEL_CLOSED: {
    code: "CHANNEL_CLOSED",
    message: "Relay v2 management channel closed",
    retryable: false,
  },
  SUPERSEDED: {
    code: "SUPERSEDED",
    message: "Relay v2 management owner was superseded",
    retryable: false,
  },
} as const;

type ManagementErrorCode = keyof typeof MANAGEMENT_ERRORS;
type ManagementOperation =
  | "status"
  | "bootstrap_host"
  | "refresh_host"
  | "start_connector"
  | "stop_connector"
  | "create_enrollment"
  | "revoke_client_grant";
type ManagementInvoke = (command: string, args?: unknown) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseManagementError(value: unknown): ManagementErrorCode | null {
  const input = record(value);
  if (!input || !exactKeys(input, ["code", "message", "retryable"])) return null;
  for (const code of Object.keys(MANAGEMENT_ERRORS) as ManagementErrorCode[]) {
    const expected = MANAGEMENT_ERRORS[code];
    if (
      input.code === expected.code
      && input.message === expected.message
      && input.retryable === expected.retryable
    ) return code;
  }
  return null;
}

function parseDefaultOffStatus(value: unknown): boolean {
  const input = record(value);
  return !!input
    && exactKeys(input, ["availability", "capabilities", "reason"])
    && input.availability === "unavailable"
    && Array.isArray(input.capabilities)
    && input.capabilities.length === 0
    && input.reason === "default_off";
}

type DecodedOutcome = { kind: "status" } | { kind: "error"; code: ManagementErrorCode };

function decodeOutcome(value: unknown, operation: ManagementOperation): DecodedOutcome | null {
  const input = record(value);
  if (
    !input
    || !exactKeys(input, ["protocolVersion", "requestId", "ok", "result", "error"])
    || input.protocolVersion !== 1
    || typeof input.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(input.requestId)
  ) return null;

  if (
    operation === "status"
    && input.ok === true
    && parseDefaultOffStatus(input.result)
    && input.error === null
  ) return { kind: "status" };

  if (input.ok !== false || input.result !== null) return null;
  const code = parseManagementError(input.error);
  if (!code || code === "UNAVAILABLE" && operation === "status") return null;
  return { kind: "error", code };
}

function operationError(code: ManagementErrorCode): MobileRelayV2BackendOperationError {
  return new MobileRelayV2BackendOperationError(MANAGEMENT_ERRORS[code]);
}

function invalidOutcomeError(): MobileRelayV2BackendOperationError {
  return new MobileRelayV2BackendOperationError({
    code: "CHANNEL_CLOSED",
    message: "Relay v2 management returned an invalid outcome",
    retryable: false,
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Relay v2 management observation aborted");
  error.name = "AbortError";
  return error;
}

function callerCompletion<T>(completion: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return completion;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function defaultOffDashboardState(): MobileRelayV2DashboardState {
  return {
    authority: { kind: "unavailable", reason: DEFAULT_OFF_REASON },
    v1Profile: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured: false,
    },
    hostCredential: {
      protocolVersion: 2,
      credentialKind: "twcap2_grant",
      status: "missing",
      credentialReference: null,
      expiresAtMs: null,
      error: null,
      retryable: null,
    },
    connector: {
      status: "stopped",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    },
    enrollment: { status: "idle" },
    knownClientGrant: { status: "unknown" },
  };
}

export function createRelayV2ManagementV1Adapter(
  invoke: ManagementInvoke,
): MobileRelayV2ProductAdapter {
  let barrier: Promise<void> = Promise.resolve();

  const enqueue = (
    operation: ManagementOperation,
    signal?: AbortSignal,
  ): Promise<MobileRelayV2DashboardState> => {
    const completion = barrier.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      let raw: unknown;
      try {
        raw = await invoke(COMMAND, { operation });
      } catch (error) {
        const code = parseManagementError(error);
        throw code ? operationError(code) : invalidOutcomeError();
      }
      const outcome = decodeOutcome(raw, operation);
      if (!outcome) throw invalidOutcomeError();
      if (outcome.kind === "error") throw operationError(outcome.code);
      return defaultOffDashboardState();
    });
    barrier = completion.then(
      () => undefined,
      () => undefined,
    );
    return callerCompletion(completion, signal);
  };

  return {
    status: (signal) => enqueue("status", signal),
    bootstrapHost: () => enqueue("bootstrap_host"),
    refreshHost: () => enqueue("refresh_host"),
    startConnector: () => enqueue("start_connector"),
    stopConnector: () => enqueue("stop_connector"),
    createEnrollment: (_input) => enqueue("create_enrollment"),
    revokeClientGrant: (_input) => enqueue("revoke_client_grant"),
  };
}
