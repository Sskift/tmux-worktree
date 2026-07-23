import { types as nodeUtilTypes } from "node:util";

import {
  isRelayV2HostCredentialAuthority,
  isRelayV2HostCredentialReference,
  type RelayV2HostCredentialAuthority,
} from "./hostCredentialAuthority.js";
import {
  isRelayV2HostCredentialExchangeCoordinatorForAuthority,
  isRelayV2HostCredentialOwnerBoundExchangePort,
  RelayV2HostCredentialExchangeCoordinator,
} from "./hostCredentialExchangeCoordinator.js";
import { isRelayV2AuthIdentifier } from "./token.js";

/**
 * Default-off, unwired lifecycle owner for one host credential's
 * auth-expiring → durable refresh CAS → exact carrier reauthentication flow.
 *
 * Authority binding (no ad-hoc port assembly):
 * - Credential inspection and the durable refresh exchange are consumed only
 *   through the branded owner-bound exchange port issued by the injected
 *   coordinator at construction. The coordinator is pairing-checked against
 *   the injected branded credential authority, so `inspect`, `capture`,
 *   `refresh`, and `release` provably belong to the same canonical authority;
 *   this owner never accepts a caller-assembled `{ inspect, refresh }` struct.
 * - The managed connector port is the exact-cut contract of
 *   `RelayV2HostManagedConnectorRuntimeComposition.inspect()` /
 *   `requestReauthentication()`. Every warning, initial send, timer replay,
 *   and late completion first re-reads and re-validates the same bound
 *   `{ controllerGeneration, connectorId }` cut; a replaced generation fences
 *   the job instead of adopting the new cut.
 * - Production injection must pass the managed composition handle opened by
 *   `openRelayV2HostManagedWssConnectorRuntimeComposition` with the same
 *   credential authority: that opener brand-checks the authority's single
 *   injection, and every send here only consumes the pending request identity
 *   the same authority durably persisted. A mismatched authority fails the
 *   carrier's own durable preparation, the send returns false, and this owner
 *   closes the round fail-safe without a frame.
 *
 * Once-only and bounded recovery: one broker warning owns one bounded job.
 * Concurrent warnings coalesce onto the same in-flight outcome promise; there
 * is no per-signal queue. A failed refresh exchange or a refused send (false
 * after the durable persist) arms a bounded authority-driven retry that
 * re-reads durable state every round, reuses the authority-saved pending
 * refresh attempt, and resends only the exact persisted pending requestId —
 * never minting a replacement attempt or request and never queueing a
 * parallel exchange. After a successful send, an independent bounded ACK-loss
 * replay chain resends only the authority-proven persisted pending requestId
 * until the ACK lands or the budget ends; it never refreshes and never mints.
 *
 * Close semantics: `close()` fences new signals, advances the job generation,
 * aborts the canonical exchange signal passed to `refresh`, cancels every
 * timer, and settles within a bounded deadline. The deadline only fences and
 * settles the close barrier; it never fakes the underlying cancellation. A
 * late exchange completion re-enters through the generation fence, resolves
 * the job `{ status: "closed" }`, and can neither send nor mutate owner state.
 *
 * Failure semantics: corrupt/undecodable authority state, an authority that
 * changed grant/host under the active carrier, a carrier port that breaks the
 * exact-cut or boolean contract, and a malformed signal seal this owner
 * fail-closed. A failed refresh exchange or an unavailable carrier fails only
 * the current bounded job; durable state is preserved and a later warning
 * re-drives the same authority-owned attempt. This owner never rebuilds a
 * connector, never falls back to another protocol, and construction has no
 * side effects and advertises no capability, readiness, or qualification.
 */

/** Bounded authority-driven retry: rounds 2..4 run on this interval. */
const RETRY_INTERVAL_MS = 5_000;
/** Total rounds per job, including the synchronous first round. */
const JOB_MAX_ROUNDS = 4;
/** Bounded ACK-loss replay policy for one unacknowledged exact pending request. */
const RESEND_INTERVAL_MS = 5_000;
const RESEND_MAX_SENDS = 3;
/** Bounded close drain: the deadline fences and settles, never fakes cancel. */
const CLOSE_DRAIN_DEADLINE_MS = 5_000;

const MAX_COUNTER = 18_446_744_073_709_551_615n;

export type RelayV2HostReauthenticationLifecycleFailureCode =
  | "signal_invalid"
  | "authority_state_invalid"
  | "authority_mismatch"
  | "carrier_rejected";

export type RelayV2HostReauthenticationLifecycleOutcome =
  | Readonly<{ status: "requested" }>
  | Readonly<{ status: "resent" }>
  | Readonly<{ status: "already_current" }>
  | Readonly<{ status: "carrier_unavailable" }>
  | Readonly<{ status: "refresh_failed" }>
  | Readonly<{ status: "closed" }>
  | Readonly<{
      status: "failed";
      code: RelayV2HostReauthenticationLifecycleFailureCode;
    }>;

/**
 * The exact managed connector cut contract. Both methods are captured once at
 * construction as own-data properties and later invoked with their original
 * receiver; Proxy, accessor, and inherited members are rejected. `inspect`
 * must return the closed managed-connector union and `requestReauthentication`
 * must accept `{ requestId, controllerGeneration, connectorId }` and return a
 * boolean admission decision. Any contract deviation seals this owner as a
 * carrier rejection.
 */
export interface RelayV2HostReauthenticationManagedConnectorPort {
  inspect(): unknown;
  requestReauthentication(input: unknown): unknown;
}

export interface RelayV2HostReauthenticationLifecycleOwnerOptions {
  readonly hostId: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
  readonly refreshSecretReference: string;
  readonly credentialAuthority: RelayV2HostCredentialAuthority;
  readonly credentialExchangeCoordinator: RelayV2HostCredentialExchangeCoordinator;
  readonly managedConnector: RelayV2HostReauthenticationManagedConnectorPort;
  readonly idFactory: () => string;
  readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

interface AuthExpiringSignal {
  readonly grantId: string;
  readonly expiresAtMs: number;
  readonly refreshRecommendedAtMs: number;
}

interface PendingAttemptSnapshot {
  readonly kind: "bootstrap" | "refresh";
  readonly attemptId: string;
  readonly oldCredentialVersion: string;
  readonly oldSecretReference: string;
}

interface PendingReauthenticationSnapshot {
  readonly credentialReference: string;
  readonly credentialVersion: string;
  readonly requestId: string;
  readonly grantId: string;
  readonly accessJti: string;
}

interface CredentialInspectionSnapshot {
  readonly credentialVersion: string;
  readonly hostId: string;
  readonly principalId: string | null;
  readonly grantId: string | null;
  readonly accessJti: string | null;
  readonly accessExpiresAtMs: number | null;
  readonly refreshExpiresAtMs: number | null;
  readonly pendingCredentialAttempt: PendingAttemptSnapshot | null;
  readonly pendingReauthentication: PendingReauthenticationSnapshot | null;
}

interface ManagedCutSnapshot {
  readonly status: "stopped" | "starting" | "registered_incomplete" | "failed" | "superseded";
  readonly controllerGeneration: string;
  readonly connectorId: string | null;
}

interface BoundConnectorCut {
  readonly controllerGeneration: string;
  readonly connectorId: string;
}

interface CapturedCredentialPort {
  readonly receiver: object;
  readonly inspect: (...args: unknown[]) => unknown;
  readonly capture: (...args: unknown[]) => unknown;
  readonly refresh: (...args: unknown[]) => unknown;
  readonly release: (...args: unknown[]) => unknown;
}

interface CapturedManagedConnector {
  readonly receiver: object;
  readonly inspect: (...args: unknown[]) => unknown;
  readonly requestReauthentication: (...args: unknown[]) => unknown;
}

interface JobState {
  promise: Promise<RelayV2HostReauthenticationLifecycleOutcome>;
  readonly generation: number;
  boundCut: BoundConnectorCut | null;
}

interface RetryWait {
  cancel(): void;
  poke(): void;
}

interface ReplayChain {
  readonly cut: BoundConnectorCut;
  remaining: number;
  cancel: (() => void) | null;
}

type RoundFailure = "carrier_unavailable" | "refresh_failed";

interface RoundResult {
  readonly terminal: RelayV2HostReauthenticationLifecycleOutcome | null;
  readonly failure: RoundFailure | null;
}

const OUTCOME_REQUESTED: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "requested",
});
const OUTCOME_RESENT: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "resent",
});
const OUTCOME_ALREADY_CURRENT: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "already_current",
});
const OUTCOME_CARRIER_UNAVAILABLE: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "carrier_unavailable",
});
const OUTCOME_REFRESH_FAILED: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "refresh_failed",
});
const OUTCOME_CLOSED: RelayV2HostReauthenticationLifecycleOutcome = Object.freeze({
  status: "closed",
});
const FAILED_OUTCOMES: Readonly<
  Record<
    RelayV2HostReauthenticationLifecycleFailureCode,
    RelayV2HostReauthenticationLifecycleOutcome
  >
> = Object.freeze({
  signal_invalid: Object.freeze({ status: "failed", code: "signal_invalid" }),
  authority_state_invalid: Object.freeze({
    status: "failed",
    code: "authority_state_invalid",
  }),
  authority_mismatch: Object.freeze({ status: "failed", code: "authority_mismatch" }),
  carrier_rejected: Object.freeze({ status: "failed", code: "carrier_rejected" }),
});

function terminalRound(
  outcome: RelayV2HostReauthenticationLifecycleOutcome,
): RoundResult {
  return { terminal: outcome, failure: null };
}

function retryRound(failure: RoundFailure): RoundResult {
  return { terminal: null, failure };
}

function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (isRejectedProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * One-shot own-data snapshot: exact enumerable string keys, data descriptors
 * only, no Proxy/accessor/symbol/non-enumerable member and no thenable.
 */
function captureExactOwnDataValues(
  value: unknown,
  fields: readonly string[],
): readonly unknown[] | null {
  if (!isPlainDataObject(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const expected = new Set(fields);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !expected.has(key))) return null;
  const values: unknown[] = [];
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true) return null;
    values.push(descriptor.value);
  }
  return values;
}

function capturePortMethod(
  port: unknown,
  name: string,
): { receiver: object; method: (...args: unknown[]) => unknown } | null {
  if (port === null || typeof port !== "object" || isRejectedProxy(port)) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(port, name);
  } catch {
    return null;
  }
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "function") return null;
  return {
    receiver: port,
    method: descriptor.value as (...args: unknown[]) => unknown,
  };
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Identifiers that may be logged/correlated must never look like secret material. */
function isPlainIdentifier(value: unknown): value is string {
  return isRelayV2AuthIdentifier(value)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(value);
}

function isCanonicalCounter(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_COUNTER;
  } catch {
    return false;
  }
}

function isControllerGeneration(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_COUNTER;
  } catch {
    return false;
  }
}

function snapshotSignal(value: unknown): AuthExpiringSignal | null {
  const fields = captureExactOwnDataValues(value, [
    "grantId",
    "expiresAtMs",
    "refreshRecommendedAtMs",
  ]);
  if (!fields) return null;
  const [grantId, expiresAtMs, refreshRecommendedAtMs] = fields;
  if (!isRelayV2AuthIdentifier(grantId)
    || !isTimestamp(expiresAtMs)
    || !isTimestamp(refreshRecommendedAtMs)) return null;
  return Object.freeze({ grantId, expiresAtMs, refreshRecommendedAtMs });
}

function snapshotPendingReauthentication(
  value: unknown,
  credentialReference: string,
): PendingReauthenticationSnapshot | null {
  const fields = captureExactOwnDataValues(value, [
    "credentialReference",
    "credentialVersion",
    "requestId",
    "grantId",
    "accessJti",
  ]);
  if (!fields) return null;
  const [reference, version, requestId, grantId, accessJti] = fields;
  if (reference !== credentialReference
    || !isCanonicalCounter(version)
    || !isRelayV2AuthIdentifier(requestId)
    || !isRelayV2AuthIdentifier(grantId)
    || !isRelayV2AuthIdentifier(accessJti)) return null;
  return Object.freeze({
    credentialReference: reference,
    credentialVersion: version,
    requestId,
    grantId,
    accessJti,
  });
}

function snapshotPendingCredentialAttempt(value: unknown): PendingAttemptSnapshot | null {
  const fields = captureExactOwnDataValues(value, [
    "kind",
    "attemptId",
    "oldCredentialVersion",
    "oldSecretReference",
  ]);
  if (!fields) return null;
  const [kind, attemptId, oldCredentialVersion, oldSecretReference] = fields;
  if ((kind !== "bootstrap" && kind !== "refresh")
    || !isRelayV2AuthIdentifier(attemptId)
    || !isCanonicalCounter(oldCredentialVersion)
    || !isPlainIdentifier(oldSecretReference)) return null;
  return Object.freeze({ kind, attemptId, oldCredentialVersion, oldSecretReference });
}

function snapshotInspection(
  value: unknown,
  credentialReference: string,
): CredentialInspectionSnapshot | null {
  const fields = captureExactOwnDataValues(value, [
    "credentialVersion",
    "hostId",
    "principalId",
    "grantId",
    "accessJti",
    "accessExpiresAtMs",
    "refreshExpiresAtMs",
    "pendingCredentialAttempt",
    "pendingReauthentication",
  ]);
  if (!fields) return null;
  const [
    credentialVersion,
    hostId,
    principalId,
    grantId,
    accessJti,
    accessExpiresAtMs,
    refreshExpiresAtMs,
    pendingCredentialAttempt,
    pendingReauthentication,
  ] = fields;
  if (!isCanonicalCounter(credentialVersion)
    || !isRelayV2AuthIdentifier(hostId)
    || (principalId !== null && !isRelayV2AuthIdentifier(principalId))
    || (grantId !== null && !isRelayV2AuthIdentifier(grantId))
    || (accessJti !== null && !isRelayV2AuthIdentifier(accessJti))
    || (accessExpiresAtMs !== null && !isTimestamp(accessExpiresAtMs))
    || (refreshExpiresAtMs !== null && !isTimestamp(refreshExpiresAtMs))) return null;
  const attemptSnapshot = pendingCredentialAttempt === null
    ? null
    : snapshotPendingCredentialAttempt(pendingCredentialAttempt);
  if (pendingCredentialAttempt !== null && attemptSnapshot === null) return null;
  const pendingSnapshot = pendingReauthentication === null
    ? null
    : snapshotPendingReauthentication(pendingReauthentication, credentialReference);
  if (pendingReauthentication !== null && pendingSnapshot === null) return null;
  return Object.freeze({
    credentialVersion,
    hostId,
    principalId: principalId as string | null,
    grantId: grantId as string | null,
    accessJti: accessJti as string | null,
    accessExpiresAtMs: accessExpiresAtMs as number | null,
    refreshExpiresAtMs: refreshExpiresAtMs as number | null,
    pendingCredentialAttempt: attemptSnapshot,
    pendingReauthentication: pendingSnapshot,
  });
}

function snapshotResponseCommit(value: unknown): boolean {
  const fields = captureExactOwnDataValues(value, ["status", "credentialVersion"]);
  if (!fields) return false;
  const [status, credentialVersion] = fields;
  if (status === "applied") return isCanonicalCounter(credentialVersion);
  if (status === "stale") {
    return credentialVersion === null || isCanonicalCounter(credentialVersion);
  }
  return false;
}

function snapshotManagedCut(value: unknown): ManagedCutSnapshot | null {
  if (!isPlainDataObject(value)) return null;
  let statusDescriptor: PropertyDescriptor | undefined;
  try {
    statusDescriptor = Object.getOwnPropertyDescriptor(value, "status");
  } catch {
    return null;
  }
  if (!statusDescriptor || !Object.hasOwn(statusDescriptor, "value")) return null;
  const status = statusDescriptor.value;
  if (status === "stopped") {
    const fields = captureExactOwnDataValues(value, ["status", "controllerGeneration"]);
    if (!fields || !isControllerGeneration(fields[1])) return null;
    return Object.freeze({
      status,
      controllerGeneration: fields[1],
      connectorId: null,
    });
  }
  if (status === "starting") {
    const fields = captureExactOwnDataValues(value, [
      "status",
      "controllerGeneration",
      "connectorId",
    ]);
    if (!fields || !isControllerGeneration(fields[1]) || fields[2] !== null) return null;
    return Object.freeze({
      status,
      controllerGeneration: fields[1],
      connectorId: null,
    });
  }
  if (status === "registered_incomplete") {
    const fields = captureExactOwnDataValues(value, [
      "status",
      "controllerGeneration",
      "connectorId",
      "acknowledgement",
      "negotiatedCapabilityIntersection",
    ]);
    if (!fields || !isControllerGeneration(fields[1]) || !isPlainIdentifier(fields[2])
      || fields[3] !== "host.registered"
      || !Array.isArray(fields[4])
      || isRejectedProxy(fields[4])
      || (fields[4] as readonly unknown[]).length !== 0) return null;
    return Object.freeze({
      status,
      controllerGeneration: fields[1],
      connectorId: fields[2] as string,
    });
  }
  if (status === "failed" || status === "superseded") {
    const names = status === "failed"
      ? ["status", "controllerGeneration", "connectorId", "retryable"]
      : ["status", "controllerGeneration", "connectorId"];
    const fields = captureExactOwnDataValues(value, names);
    if (!fields || !isControllerGeneration(fields[1])
      || (fields[2] !== null && !isPlainIdentifier(fields[2]))
      || (status === "failed" && typeof fields[3] !== "boolean")) return null;
    return Object.freeze({
      status,
      controllerGeneration: fields[1],
      connectorId: fields[2] as string | null,
    });
  }
  return null;
}

export class RelayV2HostReauthenticationLifecycleOwner {
  private readonly hostId: string;
  private readonly hostInstanceId: string;
  private readonly credentialReference: string;
  private readonly refreshSecretReference: string;
  private readonly credentialPort: CapturedCredentialPort;
  private readonly managedConnector: CapturedManagedConnector;
  private readonly idFactory: () => string;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly abortController = new AbortController();
  private currentJob: JobState | null = null;
  private retryWait: RetryWait | null = null;
  private replayChain: ReplayChain | null = null;
  private jobGeneration = 0;
  private sealed = false;
  private sealCode: RelayV2HostReauthenticationLifecycleFailureCode = "signal_invalid";
  private closed = false;
  private closeBarrier: Promise<void> | null = null;

  constructor(options: RelayV2HostReauthenticationLifecycleOwnerOptions) {
    const fields = captureExactOwnDataValues(options, [
      "hostId",
      "hostInstanceId",
      "credentialReference",
      "refreshSecretReference",
      "credentialAuthority",
      "credentialExchangeCoordinator",
      "managedConnector",
      "idFactory",
      "schedule",
    ]);
    const [
      hostId,
      hostInstanceId,
      credentialReference,
      refreshSecretReference,
      credentialAuthority,
      credentialExchangeCoordinator,
      managedConnector,
      idFactory,
      schedule,
    ] = fields ?? [];
    if (!fields
      || !isPlainIdentifier(hostId)
      || !isPlainIdentifier(hostInstanceId)
      || !isRelayV2HostCredentialReference(credentialReference)
      || !isPlainIdentifier(refreshSecretReference)
      || !isRelayV2HostCredentialAuthority(credentialAuthority)
      || !isRelayV2HostCredentialExchangeCoordinatorForAuthority(
        credentialExchangeCoordinator,
        credentialAuthority,
      )
      || typeof idFactory !== "function"
      || typeof schedule !== "function") {
      throw new Error("Relay v2 host reauthentication lifecycle owner options are invalid");
    }
    // The branded owner-bound port is the only credential channel: it proves
    // inspect/capture/refresh/release all belong to the paired authority.
    let port: unknown = null;
    try {
      port = Reflect.apply(
        RelayV2HostCredentialExchangeCoordinator.prototype.createOwnerBoundPort,
        credentialExchangeCoordinator,
        [],
      );
    } catch {
      port = null;
    }
    const inspect = capturePortMethod(port, "inspect");
    const capture = capturePortMethod(port, "capture");
    const refresh = capturePortMethod(port, "refresh");
    const release = capturePortMethod(port, "release");
    const connectorInspect = capturePortMethod(managedConnector, "inspect");
    const requestReauthentication = capturePortMethod(
      managedConnector,
      "requestReauthentication",
    );
    if (!isRelayV2HostCredentialOwnerBoundExchangePort(port)
      || !inspect || !capture || !refresh || !release
      || !connectorInspect || !requestReauthentication) {
      throw new Error("Relay v2 host reauthentication lifecycle owner ports are invalid");
    }
    this.hostId = hostId;
    this.hostInstanceId = hostInstanceId;
    this.credentialReference = credentialReference;
    this.refreshSecretReference = refreshSecretReference;
    this.credentialPort = Object.freeze({
      receiver: port,
      inspect: inspect.method,
      capture: capture.method,
      refresh: refresh.method,
      release: release.method,
    });
    this.managedConnector = Object.freeze({
      receiver: managedConnector as object,
      inspect: connectorInspect.method,
      requestReauthentication: requestReauthentication.method,
    });
    this.idFactory = idFactory as () => string;
    this.schedule = schedule as (delayMs: number, callback: () => void) => () => void;
  }

  /**
   * Carrier `onAuthExpiring` entry. Never rejects: every signal settles with a
   * closed outcome. Concurrent signals coalesce onto the single in-flight job
   * and share its bounded outcome.
   */
  handleAuthExpiring(
    input: unknown,
  ): Promise<RelayV2HostReauthenticationLifecycleOutcome> {
    if (this.closed) return Promise.resolve(OUTCOME_CLOSED);
    if (this.sealed) return Promise.resolve(FAILED_OUTCOMES[this.sealCode]);
    let signal: AuthExpiringSignal | null;
    try {
      signal = snapshotSignal(input);
    } catch {
      signal = null;
    }
    if (signal === null) return Promise.resolve(this.seal("signal_invalid"));
    const accepted = signal;
    const current = this.currentJob;
    if (current !== null) return current.promise;
    const job: JobState = {
      promise: undefined as never,
      generation: this.jobGeneration,
      boundCut: null,
    };
    this.currentJob = job;
    job.promise = (async () => {
      try {
        return await this.runJob(job, accepted);
      } catch {
        return this.seal("authority_state_invalid");
      } finally {
        if (this.currentJob === job) this.currentJob = null;
      }
    })();
    // The job promise never rejects; keep a defensive observer anyway so the
    // carrier callback path can never surface an unhandled rejection.
    void job.promise.catch(() => {});
    return job.promise;
  }

  /**
   * Fence new signals, abort the in-flight exchange signal, cancel timers, and
   * settle within a bounded deadline. The deadline only fences and settles;
   * a late exchange continuation dies at the job generation fence.
   */
  close(): Promise<void> {
    if (this.closeBarrier !== null) return this.closeBarrier;
    this.closed = true;
    this.jobGeneration += 1;
    this.abortController.abort();
    this.cancelRetryWait();
    this.cancelReplayChain();
    const job = this.currentJob;
    this.closeBarrier = new Promise<void>((resolve) => {
      if (job === null) {
        resolve();
        return;
      }
      let settled = false;
      let cancelDeadline: (() => void) | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        const cancel = cancelDeadline;
        cancelDeadline = null;
        if (cancel !== null) {
          try {
            Reflect.apply(cancel, undefined, []);
          } catch {
            // A broken cancellation receipt must not block the close barrier.
          }
        }
        resolve();
      };
      void job.promise.then(settle, settle);
      let receipt: unknown;
      try {
        receipt = Reflect.apply(this.schedule, undefined, [CLOSE_DRAIN_DEADLINE_MS, settle]);
      } catch {
        // A broken scheduler degrades to an immediate fence-and-settle.
        settle();
        return;
      }
      if (typeof receipt !== "function") {
        settle();
        return;
      }
      cancelDeadline = receipt as () => void;
    });
    return this.closeBarrier;
  }

  private async runJob(
    job: JobState,
    signal: AuthExpiringSignal,
  ): Promise<RelayV2HostReauthenticationLifecycleOutcome> {
    let roundsLeft = JOB_MAX_ROUNDS;
    let lastFailure: RelayV2HostReauthenticationLifecycleOutcome = OUTCOME_CARRIER_UNAVAILABLE;
    for (;;) {
      const fence = this.jobFence(job);
      if (fence !== null) return fence;
      const round = await this.runRound(job, signal);
      if (round.terminal !== null) return round.terminal;
      lastFailure = round.failure === "refresh_failed"
        ? OUTCOME_REFRESH_FAILED
        : OUTCOME_CARRIER_UNAVAILABLE;
      roundsLeft -= 1;
      // Budget exhaustion is not sticky: the durable state is preserved and a
      // later warning re-drives the same authority-owned attempt.
      if (roundsLeft <= 0) return lastFailure;
      if (!(await this.waitRetryInterval())) return lastFailure;
    }
  }

  private async runRound(
    job: JobState,
    signal: AuthExpiringSignal,
  ): Promise<RoundResult> {
    const cut = this.readManagedCut();
    if (cut === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    if (job.boundCut !== null) {
      if (cut.status !== "registered_incomplete"
        || cut.controllerGeneration !== job.boundCut.controllerGeneration
        || cut.connectorId !== job.boundCut.connectorId) {
        // The bound carrier cut was replaced: fence the job. Never adopt the
        // new cut and never retry into it.
        return terminalRound(OUTCOME_CARRIER_UNAVAILABLE);
      }
    } else if (cut.status === "registered_incomplete") {
      // First-bind-wins: the whole job stays on this exact connector cut.
      job.boundCut = {
        controllerGeneration: cut.controllerGeneration,
        connectorId: cut.connectorId,
      };
    } else {
      return retryRound("carrier_unavailable");
    }
    const inspection = this.readInspection();
    if (inspection === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    if (inspection.grantId !== signal.grantId || inspection.hostId !== this.hostId) {
      return terminalRound(this.seal("authority_mismatch"));
    }
    if (inspection.pendingReauthentication !== null) {
      // ACK/transport loss, a refused admission after the durable persist, or
      // a reentered warning: resend only the exact persisted pending request
      // identity; never mint a second request and never refresh again.
      return this.sendExactPendingRequest(
        job,
        inspection.pendingReauthentication.requestId,
        OUTCOME_RESENT,
      );
    }
    if (inspection.accessExpiresAtMs !== null
      && inspection.accessExpiresAtMs > signal.expiresAtMs) {
      return terminalRound(OUTCOME_ALREADY_CURRENT);
    }
    const pending = inspection.pendingCredentialAttempt;
    const attemptId = pending !== null && pending.kind === "refresh"
      ? pending.attemptId
      : this.nextIdentifier();
    if (attemptId === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    const oldSecretReference = pending?.oldSecretReference ?? this.refreshSecretReference;
    const exchange = await this.exchangeRefresh(attemptId, oldSecretReference);
    // A late completion re-enters here: the generation fence decides before
    // any inspection, send, or state change may happen.
    const fence = this.jobFence(job);
    if (fence !== null) return terminalRound(fence);
    if (exchange === "failed") return retryRound("refresh_failed");
    if (exchange === "sealed") return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    const after = this.readInspection();
    if (after === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    if (after.grantId !== signal.grantId || after.hostId !== this.hostId) {
      return terminalRound(this.seal("authority_mismatch"));
    }
    if (BigInt(after.credentialVersion) <= BigInt(inspection.credentialVersion)) {
      // The durable commit (or an authority-proven winner) must have advanced
      // the credential before the new token may go on the wire.
      return terminalRound(this.seal("authority_mismatch"));
    }
    const requestId = this.nextIdentifier();
    if (requestId === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    return this.sendExactPendingRequest(job, requestId, OUTCOME_REQUESTED);
  }

  /**
   * The carrier persists the exact pending request inside its own durable
   * preparation before anything is enqueued; this owner only re-reads that
   * persisted identity and never sends before the authority's CAS succeeds.
   */
  private sendExactPendingRequest(
    job: JobState,
    requestId: string,
    outcome: RelayV2HostReauthenticationLifecycleOutcome,
  ): RoundResult {
    const bound = job.boundCut;
    if (bound === null) return terminalRound(OUTCOME_CARRIER_UNAVAILABLE);
    const cut = this.readManagedCut();
    if (cut === null) return terminalRound(FAILED_OUTCOMES[this.sealCode]);
    if (cut.status !== "registered_incomplete"
      || cut.controllerGeneration !== bound.controllerGeneration
      || cut.connectorId !== bound.connectorId) {
      return terminalRound(OUTCOME_CARRIER_UNAVAILABLE);
    }
    let admitted: unknown;
    try {
      admitted = Reflect.apply(
        this.managedConnector.requestReauthentication,
        this.managedConnector.receiver,
        [Object.freeze({
          requestId,
          controllerGeneration: bound.controllerGeneration,
          connectorId: bound.connectorId,
        })],
      );
    } catch {
      return terminalRound(this.seal("carrier_rejected"));
    }
    // The send re-entered owner lifecycle (close/seal): drop the outcome.
    const fence = this.jobFence(job);
    if (fence !== null) return terminalRound(fence);
    if (typeof admitted !== "boolean") return terminalRound(this.seal("carrier_rejected"));
    if (!admitted) return retryRound("carrier_unavailable");
    this.armReplayChain(bound);
    return terminalRound(outcome);
  }

  private async exchangeRefresh(
    attemptId: string,
    oldSecretReference: string,
  ): Promise<"ok" | "failed" | "sealed"> {
    let captured: unknown;
    try {
      captured = Reflect.apply(this.credentialPort.capture, this.credentialPort.receiver, [
        Object.freeze({
          credentialReference: this.credentialReference,
          hostId: this.hostId,
        }),
      ]);
    } catch {
      return "failed";
    }
    let cut: unknown = null;
    try {
      cut = captureExactOwnDataValues(captured, ["inspection", "cut"])?.[1] ?? null;
    } catch {
      cut = null;
    }
    if (cut === null || (typeof cut !== "object" && typeof cut !== "function")) {
      this.seal("authority_state_invalid");
      return "sealed";
    }
    const input = Object.freeze({
      credentialReference: this.credentialReference,
      attemptId,
      oldSecretReference,
      hostInstanceId: this.hostInstanceId,
    });
    let value: unknown;
    let state: "ok" | "failed" | "sealed" = "failed";
    try {
      const raw = Reflect.apply(this.credentialPort.refresh, this.credentialPort.receiver, [
        cut,
        input,
        this.abortController.signal,
      ]);
      if (!(raw instanceof Promise)) {
        this.seal("authority_state_invalid");
        state = "sealed";
      } else {
        value = await raw;
        state = "ok";
      }
    } catch {
      // A sync throw or a rejection is a failed exchange, not an owner fault.
    } finally {
      this.releaseCut(cut);
    }
    if (state !== "ok") return state;
    let commit = false;
    try {
      commit = snapshotResponseCommit(value);
    } catch {
      commit = false;
    }
    if (!commit) {
      this.seal("authority_state_invalid");
      return "sealed";
    }
    return "ok";
  }

  /** The canonical release is idempotent; a broken release must not mask the outcome. */
  private releaseCut(cut: unknown): void {
    try {
      Reflect.apply(this.credentialPort.release, this.credentialPort.receiver, [cut]);
    } catch {
      // Ignored deliberately.
    }
  }

  private readInspection(): CredentialInspectionSnapshot | null {
    let raw: unknown;
    try {
      raw = Reflect.apply(this.credentialPort.inspect, this.credentialPort.receiver, [
        this.credentialReference,
      ]);
    } catch {
      this.seal("authority_state_invalid");
      return null;
    }
    if (raw === null) {
      this.seal("authority_mismatch");
      return null;
    }
    let snapshot: CredentialInspectionSnapshot | null = null;
    try {
      snapshot = snapshotInspection(raw, this.credentialReference);
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      this.seal("authority_state_invalid");
      return null;
    }
    return snapshot;
  }

  private readManagedCut(): ManagedCutSnapshot | null {
    let raw: unknown;
    try {
      raw = Reflect.apply(this.managedConnector.inspect, this.managedConnector.receiver, []);
    } catch {
      this.seal("carrier_rejected");
      return null;
    }
    let snapshot: ManagedCutSnapshot | null = null;
    try {
      snapshot = snapshotManagedCut(raw);
    } catch {
      snapshot = null;
    }
    if (snapshot === null) {
      this.seal("carrier_rejected");
      return null;
    }
    return snapshot;
  }

  private nextIdentifier(): string | null {
    let value: unknown;
    try {
      value = Reflect.apply(this.idFactory, undefined, []);
    } catch {
      this.seal("authority_state_invalid");
      return null;
    }
    if (!isPlainIdentifier(value)) {
      this.seal("authority_state_invalid");
      return null;
    }
    return value;
  }

  /** A late job continuation must not act after close, seal, or replacement. */
  private jobFence(
    job: JobState,
  ): RelayV2HostReauthenticationLifecycleOutcome | null {
    if (this.sealed) return FAILED_OUTCOMES[this.sealCode];
    if (this.closed
      || this.jobGeneration !== job.generation
      || this.currentJob !== job) return OUTCOME_CLOSED;
    return null;
  }

  /**
   * Waits one retry interval. Resolves true when the round loop may continue
   * (timer fired, or close/seal poked the job into its generation fence) and
   * false when the injected scheduler is broken, which degrades the bounded
   * retry away: the job settles with its last failure outcome.
   */
  private waitRetryInterval(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let cancelReceipt: (() => void) | null = null;
      const entry: RetryWait = {
        cancel() {
          const cancel = cancelReceipt;
          cancelReceipt = null;
          if (cancel !== null) {
            try {
              Reflect.apply(cancel, undefined, []);
            } catch {
              // A broken cancellation receipt must not block close or seal.
            }
          }
        },
        poke() {
          finish(true);
        },
      };
      const finish = (proceed: boolean): void => {
        if (settled) return;
        settled = true;
        if (this.retryWait === entry) this.retryWait = null;
        resolve(proceed);
      };
      let receipt: unknown;
      try {
        receipt = Reflect.apply(this.schedule, undefined, [
          RETRY_INTERVAL_MS,
          () => finish(true),
        ]);
      } catch {
        resolve(false);
        return;
      }
      if (typeof receipt !== "function") {
        resolve(false);
        return;
      }
      cancelReceipt = receipt as () => void;
      this.retryWait = entry;
    });
  }

  private cancelRetryWait(): void {
    const wait = this.retryWait;
    this.retryWait = null;
    if (wait === null) return;
    wait.cancel();
    wait.poke();
  }

  private armReplayChain(cut: BoundConnectorCut): void {
    if (this.replayChain !== null || this.closed || this.sealed) return;
    const chain: ReplayChain = {
      cut: Object.freeze({ ...cut }),
      remaining: RESEND_MAX_SENDS,
      cancel: null,
    };
    this.replayChain = chain;
    this.scheduleReplay(chain);
  }

  private scheduleReplay(chain: ReplayChain): void {
    let receipt: unknown;
    try {
      receipt = Reflect.apply(this.schedule, undefined, [
        RESEND_INTERVAL_MS,
        () => this.replayFired(chain),
      ]);
    } catch {
      // A broken scheduler degrades the bounded replay chain away.
      if (this.replayChain === chain) this.replayChain = null;
      return;
    }
    if (typeof receipt !== "function") {
      if (this.replayChain === chain) this.replayChain = null;
      return;
    }
    chain.cancel = receipt as () => void;
  }

  private replayFired(chain: ReplayChain): void {
    if (this.replayChain !== chain) return;
    this.replayChain = null;
    if (this.closed || this.sealed) return;
    const cut = this.readManagedCut();
    if (cut === null) return;
    if (cut.status !== "registered_incomplete"
      || cut.controllerGeneration !== chain.cut.controllerGeneration
      || cut.connectorId !== chain.cut.connectorId) return;
    const inspection = this.readInspection();
    if (inspection === null) return;
    const pending = inspection.pendingReauthentication;
    // The ACK landed durably: the chain stops. Anything else resends only the
    // exact persisted pending request identity through the same bound cut.
    if (pending === null || chain.remaining <= 0) return;
    let admitted: unknown;
    try {
      admitted = Reflect.apply(
        this.managedConnector.requestReauthentication,
        this.managedConnector.receiver,
        [Object.freeze({
          requestId: pending.requestId,
          controllerGeneration: chain.cut.controllerGeneration,
          connectorId: chain.cut.connectorId,
        })],
      );
    } catch {
      this.seal("carrier_rejected");
      return;
    }
    if (this.closed || this.sealed) return;
    if (typeof admitted !== "boolean") {
      this.seal("carrier_rejected");
      return;
    }
    // The carrier alone decides admission on its current connector; a refused
    // replay leaves the durable pending request for the next authority-driven
    // trigger instead of retrying outside it.
    if (!admitted) return;
    chain.remaining -= 1;
    if (chain.remaining <= 0) return;
    this.replayChain = chain;
    this.scheduleReplay(chain);
  }

  private cancelReplayChain(): void {
    const chain = this.replayChain;
    this.replayChain = null;
    const cancel = chain?.cancel;
    if (cancel) {
      try {
        Reflect.apply(cancel, undefined, []);
      } catch {
        // A broken cancellation receipt must not block close or seal.
      }
    }
  }

  private seal(
    code: RelayV2HostReauthenticationLifecycleFailureCode,
  ): RelayV2HostReauthenticationLifecycleOutcome {
    if (!this.sealed) {
      this.sealed = true;
      this.sealCode = code;
      this.jobGeneration += 1;
      this.abortController.abort();
      this.cancelRetryWait();
      this.cancelReplayChain();
    }
    return FAILED_OUTCOMES[this.sealCode];
  }
}
