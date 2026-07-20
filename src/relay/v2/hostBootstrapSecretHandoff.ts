import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2HostBootstrapSecretHandoff,
  RelayV2HostBootstrapSecretHandoffCandidate,
} from "./hostCredentialVault.js";

const MAX_BOOTSTRAP_SECRET_BYTES = 8_192;
const promisePrototypeThen = Promise.prototype.then;

type CandidatePhase = "ready" | "in_flight" | "consumed" | "closed";

interface CandidateRecord {
  phase: CandidatePhase;
  secret: string | null;
}

export interface RelayV2HostBootstrapSecretPrivilegedIntakePort {
  accept(bootstrapSecret: string): RelayV2HostBootstrapSecretHandoffCandidate;
}

export interface RelayV2HostBootstrapSecretHandoffAuthority {
  readonly privilegedIntake: RelayV2HostBootstrapSecretPrivilegedIntakePort;
  readonly handoff: RelayV2HostBootstrapSecretHandoff;
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostBootstrapSecretHandoffErrorCode =
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_INTAKE_INVALID"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED"
  | "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED";

export class RelayV2HostBootstrapSecretHandoffError extends Error {
  constructor(readonly code: RelayV2HostBootstrapSecretHandoffErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2HostBootstrapSecretHandoffError";
  }
}

function messageForCode(code: RelayV2HostBootstrapSecretHandoffErrorCode): string {
  switch (code) {
    case "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_INTAKE_INVALID":
      return "Relay v2 host bootstrap secret intake is invalid";
    case "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE":
      return "Relay v2 host bootstrap secret handoff candidate is unavailable";
    case "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED":
      return "Relay v2 host bootstrap secret handoff callback must be synchronous";
    case "RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED":
      return "Relay v2 host bootstrap secret handoff is closed";
  }
}

function fail(code: RelayV2HostBootstrapSecretHandoffErrorCode): never {
  throw new RelayV2HostBootstrapSecretHandoffError(code);
}

function isBootstrapSecret(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("twhostboot2.")
    && Buffer.byteLength(value, "utf8") <= MAX_BOOTSTRAP_SECRET_BYTES
    && /^[\x21-\x7e]+$/.test(value);
}

function rejectAsynchronousCallbackResult(value: unknown): void {
  if (nodeUtilTypes.isPromise(value)) {
    try {
      void promisePrototypeThen.call(value, undefined, () => undefined);
    } catch {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED");
    }
    return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED");
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
  let then: unknown;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED");
  }
  if (typeof then === "function") {
    return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_ASYNC_CALLBACK_UNSUPPORTED");
  }
}

function frozenMethodPort<T extends object>(
  name: string,
  method: (...args: never[]) => unknown,
): T {
  const port = Object.create(null) as T;
  Object.defineProperty(port, name, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: method,
  });
  return Object.freeze(port);
}

/**
 * Default-off, process-local owner for the one-time transfer of one profile's
 * raw bootstrap secret from a privileged intake to the credential vault. It
 * owns no source, storage, credential state, exchange, timer, process, or
 * network work.
 */
export function createRelayV2HostBootstrapSecretHandoffAuthority(
): RelayV2HostBootstrapSecretHandoffAuthority {
  let lifecycle: "open" | "closing" | "closed" = "open";
  let admittedCallbacks = 0;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  const candidates = new WeakMap<object, CandidateRecord>();
  const activeRecords = new Set<CandidateRecord>();

  const closeReadyRecord = (record: CandidateRecord): void => {
    if (record.phase !== "ready") return;
    record.phase = "closed";
    record.secret = null;
    activeRecords.delete(record);
  };

  const settleCloseIfReady = (): void => {
    if (lifecycle !== "closing" || admittedCallbacks !== 0) return;
    for (const record of activeRecords) closeReadyRecord(record);
    lifecycle = "closed";
    const resolve = resolveClose;
    resolveClose = null;
    resolve?.();
  };

  const accept = (
    bootstrapSecret: string,
  ): RelayV2HostBootstrapSecretHandoffCandidate => {
    if (lifecycle !== "open") {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED");
    }
    if (!isBootstrapSecret(bootstrapSecret)) {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_INTAKE_INVALID");
    }
    const candidate = Object.freeze(
      Object.create(null),
    ) as RelayV2HostBootstrapSecretHandoffCandidate;
    const record: CandidateRecord = {
      phase: "ready",
      secret: bootstrapSecret,
    };
    candidates.set(candidate as object, record);
    activeRecords.add(record);
    return candidate;
  };

  const runWithCandidate = <T>(
    candidate: RelayV2HostBootstrapSecretHandoffCandidate,
    operation: (bootstrapSecret: string) => T,
  ): T => {
    if (lifecycle !== "open") {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CLOSED");
    }
    const record = typeof candidate === "object" && candidate !== null
      ? candidates.get(candidate as object)
      : undefined;
    if (!record || record.phase !== "ready" || typeof operation !== "function") {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE");
    }
    const secret = record.secret;
    if (secret === null) {
      return fail("RELAY_V2_HOST_BOOTSTRAP_SECRET_HANDOFF_CANDIDATE_UNAVAILABLE");
    }

    record.phase = "in_flight";
    admittedCallbacks += 1;
    let returnedNormally = false;
    try {
      const result = operation(secret);
      rejectAsynchronousCallbackResult(result);
      returnedNormally = true;
      return result;
    } finally {
      admittedCallbacks -= 1;
      if (returnedNormally) {
        record.phase = "consumed";
        record.secret = null;
        activeRecords.delete(record);
      } else if (lifecycle === "open") {
        record.phase = "ready";
      } else {
        record.phase = "closed";
        record.secret = null;
        activeRecords.delete(record);
      }
      settleCloseIfReady();
    }
  };

  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    lifecycle = "closing";
    closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    for (const record of activeRecords) closeReadyRecord(record);
    settleCloseIfReady();
    return closePromise;
  };

  const privilegedIntake = frozenMethodPort<RelayV2HostBootstrapSecretPrivilegedIntakePort>(
    "accept",
    accept as (...args: never[]) => unknown,
  );
  const handoff = frozenMethodPort<RelayV2HostBootstrapSecretHandoff>(
    "runWithCandidate",
    runWithCandidate as (...args: never[]) => unknown,
  );
  const authority = Object.create(null) as RelayV2HostBootstrapSecretHandoffAuthority;
  Object.defineProperties(authority, {
    privilegedIntake: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: privilegedIntake,
    },
    handoff: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: handoff,
    },
    closeAndDrain: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: closeAndDrain,
    },
  });
  return Object.freeze(authority);
}
