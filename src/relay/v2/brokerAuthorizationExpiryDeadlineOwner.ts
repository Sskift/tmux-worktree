import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2BrokerConnectionAccessExpiryResult,
} from "./brokerCore.js";

export type RelayV2BrokerAuthorizationExpiryConnectionKind = "client" | "host";

/**
 * Both methods must enter the same caller-owned serializer. The deadline
 * owner never calls failClosed concurrently with an admitted recheck.
 */
export interface RelayV2BrokerAuthorizationExpirySerializedCutPort {
  recheckConnectionAccessExpiry(
    connectionKind: RelayV2BrokerAuthorizationExpiryConnectionKind,
    connectionId: string,
    connectionIncarnation: string,
  ): RelayV2BrokerConnectionAccessExpiryResult
    | Promise<RelayV2BrokerConnectionAccessExpiryResult>;
  failClosed(): unknown;
}

export type RelayV2BrokerAuthorizationExpiryScheduleAt = (
  expiresAtMs: number,
  callback: () => void,
) => () => void;

export interface RelayV2BrokerAuthorizationExpiryDeadlineRegistration {
  unregister(): Promise<void>;
  /**
   * Re-observes the exact cut immediately (used after a serialized
   * host.reauthenticate commit). Existing timers are cancelled and re-armed
   * from the current closed credential identity; the warning once latch
   * survives only for an identical jti+exp.
   */
  refresh(): void;
}

/**
 * Host-only warning emit port bound by the caller to the exact serialized
 * BrokerCore warning cut. It resolves with the cut outcome
 * ("emitted" | "deferred" | "not_due" | "stale" | "expired" |
 * "fail_closed"); any throw, rejection or undecodable outcome fails closed.
 */
export interface RelayV2BrokerAuthorizationExpiryWarningPort {
  emitHostAuthExpiring(jti: string, expiresAtMs: number): unknown;
}

type CapturedCutPort = {
  receiver: object;
  recheckConnectionAccessExpiry: (...args: unknown[]) => unknown;
  failClosed: (...args: unknown[]) => unknown;
};

type CapturedWarningPort = {
  receiver: object;
  emitHostAuthExpiring: (...args: unknown[]) => unknown;
};

type Deadline = {
  cancel: (() => void) | null;
  armed: boolean;
  firedBeforeArmed: boolean;
};

type Entry = {
  connectionKind: RelayV2BrokerAuthorizationExpiryConnectionKind;
  connectionId: string;
  connectionIncarnation: string;
  state: "current" | "retired";
  deadline: Deadline | null;
  admittedCut: Promise<void> | null;
  pendingFire: boolean;
  consecutiveEarlyFires: number;
  warningPort: CapturedWarningPort | null;
  warningDeadline: Deadline | null;
  warningJti: string | null;
  warningExpiresAtMs: number | null;
  warningFired: boolean;
  warningConsecutiveEarlyFires: number;
  warningAttemptGeneration: number;
  pendingRefresh: boolean;
};

const MAX_CONSECUTIVE_EARLY_FIRES = 2;

/** host.auth_expiring is emitted exactly once per credential at exp-60s. */
const HOST_AUTH_EXPIRING_WARNING_LEAD_MS = 60_000;

const WARNING_CUT_OUTCOMES = new Set([
  "emitted",
  "deferred",
  "not_due",
  "stale",
  "expired",
  "closed",
  "fail_closed",
]);

function parseWarningCutOutcome(value: unknown): string | null {
  return typeof value === "string" && WARNING_CUT_OUTCOMES.has(value) ? value : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
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

function captureCutPort(
  source: RelayV2BrokerAuthorizationExpirySerializedCutPort,
): CapturedCutPort {
  if (source === null || typeof source !== "object" || isRejectedProxy(source)) {
    throw new Error("invalid Relay v2 authorization-expiry serialized cut port");
  }
  try {
    const recheck = Object.getOwnPropertyDescriptor(source, "recheckConnectionAccessExpiry");
    const failClosed = Object.getOwnPropertyDescriptor(source, "failClosed");
    if (
      !recheck
      || !("value" in recheck)
      || typeof recheck.value !== "function"
      || !failClosed
      || !("value" in failClosed)
      || typeof failClosed.value !== "function"
    ) throw new Error("invalid serialized cut methods");
    return {
      receiver: source,
      recheckConnectionAccessExpiry: recheck.value as (...args: unknown[]) => unknown,
      failClosed: failClosed.value as (...args: unknown[]) => unknown,
    };
  } catch {
    throw new Error("invalid Relay v2 authorization-expiry serialized cut port");
  }
}

function captureWarningPort(
  source: RelayV2BrokerAuthorizationExpiryWarningPort,
): CapturedWarningPort {
  if (source === null || typeof source !== "object" || isRejectedProxy(source)) {
    throw new Error("invalid Relay v2 authorization-expiry warning port");
  }
  try {
    const emit = Object.getOwnPropertyDescriptor(source, "emitHostAuthExpiring");
    if (!emit || !("value" in emit) || typeof emit.value !== "function") {
      throw new Error("invalid warning emit method");
    }
    return {
      receiver: source,
      emitHostAuthExpiring: emit.value as (...args: unknown[]) => unknown,
    };
  } catch {
    throw new Error("invalid Relay v2 authorization-expiry warning port");
  }
}

function parseCutResult(value: unknown): RelayV2BrokerConnectionAccessExpiryResult | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const outcomeDescriptor = Reflect.getOwnPropertyDescriptor(value, "outcome");
    if (!outcomeDescriptor || !("value" in outcomeDescriptor)) return null;
    const outcome = outcomeDescriptor.value;
    if (outcome === "active") {
      if (keys.length !== 3 || !keys.includes("expiresAtMs") || !keys.includes("jti")) {
        return null;
      }
      const expiresDescriptor = Reflect.getOwnPropertyDescriptor(value, "expiresAtMs");
      const jtiDescriptor = Reflect.getOwnPropertyDescriptor(value, "jti");
      if (
        !expiresDescriptor
        || !("value" in expiresDescriptor)
        || !Number.isSafeInteger(expiresDescriptor.value)
        || expiresDescriptor.value < 0
        || !jtiDescriptor
        || !("value" in jtiDescriptor)
        || !isIdentifier(jtiDescriptor.value)
      ) return null;
      return Object.freeze({
        outcome,
        jti: jtiDescriptor.value,
        expiresAtMs: expiresDescriptor.value as number,
      });
    }
    if (keys.length !== 1) return null;
    if (outcome === "expired") return Object.freeze({ outcome });
    if (outcome === "stale") return Object.freeze({ outcome });
    if (outcome === "fail_closed") return Object.freeze({ outcome });
    return null;
  } catch {
    return null;
  }
}

/**
 * Default-off timer owner for exact BrokerCore access-expiry cuts. It never
 * accepts credential material or a caller-selected deadline.
 */
export class RelayV2BrokerAuthorizationExpiryDeadlineOwner {
  private readonly clients = new Map<string, Entry>();
  private readonly hosts = new Map<string, Entry>();
  private readonly entries = new Set<Entry>();
  private readonly cutPort: CapturedCutPort;
  private readonly scheduleAt: RelayV2BrokerAuthorizationExpiryScheduleAt;
  private accepting = true;
  private closed = false;
  private sealRequested = false;
  private sealDrain: Promise<void> | null = null;
  private closeDrain: Promise<void> | null = null;

  constructor(options: {
    serializedCutPort: RelayV2BrokerAuthorizationExpirySerializedCutPort;
    scheduleAt: RelayV2BrokerAuthorizationExpiryScheduleAt;
  }) {
    this.cutPort = captureCutPort(options.serializedCutPort);
    if (typeof options.scheduleAt !== "function") {
      throw new Error("invalid Relay v2 authorization-expiry absolute scheduler");
    }
    this.scheduleAt = options.scheduleAt;
  }

  register(
    connectionKind: RelayV2BrokerAuthorizationExpiryConnectionKind,
    connectionId: string,
    connectionIncarnation: string,
    warningPort?: RelayV2BrokerAuthorizationExpiryWarningPort,
  ): RelayV2BrokerAuthorizationExpiryDeadlineRegistration {
    if (
      !this.accepting
      || this.closed
      || (connectionKind !== "client" && connectionKind !== "host")
      || !isIdentifier(connectionId)
      || !isIdentifier(connectionIncarnation)
      || (warningPort !== undefined && connectionKind !== "host")
    ) {
      throw new Error("Relay v2 authorization-expiry deadline owner is unavailable");
    }
    const capturedWarning = warningPort === undefined
      ? null
      : captureWarningPort(warningPort);
    const registry = this.registryFor(connectionKind);
    const previous = registry.get(connectionId);
    if (previous) this.retire(previous);
    if (!this.accepting) {
      throw new Error("Relay v2 authorization-expiry deadline owner is unavailable");
    }
    const entry: Entry = {
      connectionKind,
      connectionId,
      connectionIncarnation,
      state: "current",
      deadline: null,
      admittedCut: null,
      pendingFire: false,
      consecutiveEarlyFires: 0,
      warningPort: capturedWarning,
      warningDeadline: null,
      warningJti: null,
      warningExpiresAtMs: null,
      warningFired: false,
      warningConsecutiveEarlyFires: 0,
      warningAttemptGeneration: 0,
      pendingRefresh: false,
    };
    registry.set(connectionId, entry);
    this.entries.add(entry);
    this.admitCut(entry, false);
    return Object.freeze({
      unregister: async () => {
        this.retire(entry);
        await this.drainEntry(entry);
        this.entries.delete(entry);
      },
      refresh: () => {
        this.refreshEntry(entry);
      },
    });
  }

  /**
   * A refresh racing an in-flight admitted cut must not be dropped: the cut
   * may have been serialized before the reauth commit and would otherwise
   * re-arm the replaced identity. The trailing drain re-runs the refresh.
   */
  private refreshEntry(entry: Entry): void {
    if (!this.isCurrent(entry)) return;
    // Invalidate any in-flight warning attempt first, even when the
    // replacement cut has not completed yet: a late old-attempt result must
    // never re-arm, retire or seal against the refreshed identity.
    entry.warningAttemptGeneration += 1;
    if (entry.admittedCut) {
      entry.pendingRefresh = true;
      return;
    }
    const firedJti = entry.warningJti;
    const firedExpiresAtMs = entry.warningExpiresAtMs;
    const fired = entry.warningFired;
    this.cancel(entry);
    entry.warningJti = firedJti;
    entry.warningExpiresAtMs = firedExpiresAtMs;
    entry.warningFired = fired;
    entry.consecutiveEarlyFires = 0;
    this.admitCut(entry, false);
  }

  close(): Promise<void> {
    if (this.closeDrain) return this.closeDrain;
    this.accepting = false;
    this.closed = true;
    const entries = [...this.entries];
    for (const entry of entries) this.retire(entry);
    this.clients.clear();
    this.hosts.clear();
    this.closeDrain = Promise.all(entries.map((entry) => this.drainEntry(entry))).then(async () => {
      if (this.sealDrain) await this.sealDrain;
      this.entries.clear();
    });
    // Keep a rejection observable to close()/unregister() without creating an
    // unhandled rejection before the caller reaches its drain barrier.
    void this.closeDrain.catch(() => {});
    return this.closeDrain;
  }

  private registryFor(
    connectionKind: RelayV2BrokerAuthorizationExpiryConnectionKind,
  ): Map<string, Entry> {
    return connectionKind === "client" ? this.clients : this.hosts;
  }

  private isCurrent(entry: Entry): boolean {
    return this.accepting
      && !this.closed
      && entry.state === "current"
      && this.registryFor(entry.connectionKind).get(entry.connectionId) === entry;
  }

  private admitCut(entry: Entry, fromDeadline: boolean): void {
    if (!this.isCurrent(entry) || entry.admittedCut) {
      if (fromDeadline && this.isCurrent(entry)) entry.pendingFire = true;
      return;
    }
    let raw: unknown;
    try {
      raw = Reflect.apply(this.cutPort.recheckConnectionAccessExpiry, this.cutPort.receiver, [
        entry.connectionKind,
        entry.connectionId,
        entry.connectionIncarnation,
      ]);
    } catch {
      entry.admittedCut = this.requestSeal();
      return;
    }
    let admitted!: Promise<void>;
    admitted = Promise.resolve(raw).then(
      (value) => this.applyCutResult(entry, value, fromDeadline),
      () => this.requestSeal(),
    ).then(
      () => {},
      (error: unknown) => { throw error; },
    ).finally(() => {
      if (entry.admittedCut === admitted) entry.admittedCut = null;
      if (this.isCurrent(entry) && entry.pendingFire) {
        entry.pendingFire = false;
        this.admitCut(entry, true);
      }
      if (this.isCurrent(entry) && entry.pendingRefresh) {
        entry.pendingRefresh = false;
        this.refreshEntry(entry);
      }
      if (entry.state === "retired" && entry.deadline === null && !entry.admittedCut) {
        this.entries.delete(entry);
      }
    });
    // Cut decode/rejection paths resolve after serialized failClosed. Only a
    // failure of that failClosed operation itself remains observable.
    void admitted.catch(() => {});
    entry.admittedCut = admitted;
  }

  private applyCutResult(entry: Entry, value: unknown, fromDeadline: boolean): void | Promise<void> {
    if (!this.isCurrent(entry)) return;
    const result = parseCutResult(value);
    if (!result || result.outcome === "fail_closed") return this.requestSeal();
    if (result.outcome === "expired" || result.outcome === "stale") {
      this.retire(entry);
      return;
    }
    if (fromDeadline) {
      entry.consecutiveEarlyFires += 1;
      if (entry.consecutiveEarlyFires >= MAX_CONSECUTIVE_EARLY_FIRES) {
        return this.requestSeal();
      }
    } else {
      entry.consecutiveEarlyFires = 0;
    }
    return this.arm(entry, result.jti, result.expiresAtMs);
  }

  private arm(entry: Entry, jti: string, expiresAtMs: number): void | Promise<void> {
    if (!this.isCurrent(entry)) return;
    if (entry.deadline) return this.requestSeal();
    const deadline: Deadline = { cancel: null, armed: false, firedBeforeArmed: false };
    entry.deadline = deadline;
    try {
      const cancel = this.scheduleAt(expiresAtMs, () => {
        if (!deadline.armed) {
          deadline.firedBeforeArmed = true;
          return;
        }
        this.deadlineFired(entry, deadline);
      });
      if (typeof cancel !== "function") {
        throw new Error("invalid Relay v2 authorization-expiry cancellation receipt");
      }
      deadline.cancel = cancel;
      deadline.armed = true;
    } catch {
      if (entry.deadline === deadline) entry.deadline = null;
      return this.requestSeal();
    }
    if (deadline.firedBeforeArmed) this.deadlineFired(entry, deadline);
    return this.armWarning(entry, jti, expiresAtMs);
  }

  private armWarning(
    entry: Entry,
    jti: string,
    expiresAtMs: number,
  ): void | Promise<void> {
    if (!this.isCurrent(entry) || !entry.warningPort) return;
    // One warning per exact credential: any jti or expiresAtMs drift is a
    // new credential; the identical jti+exp keeps the already-fired latch.
    if (entry.warningJti !== jti || entry.warningExpiresAtMs !== expiresAtMs) {
      entry.warningJti = jti;
      entry.warningExpiresAtMs = expiresAtMs;
      entry.warningFired = false;
      entry.warningConsecutiveEarlyFires = 0;
    }
    if (entry.warningFired) return;
    if (entry.warningDeadline) return this.requestSeal();
    const deadline: Deadline = { cancel: null, armed: false, firedBeforeArmed: false };
    entry.warningDeadline = deadline;
    try {
      const cancel = this.scheduleAt(
        expiresAtMs - HOST_AUTH_EXPIRING_WARNING_LEAD_MS,
        () => {
          if (!deadline.armed) {
            deadline.firedBeforeArmed = true;
            return;
          }
          this.warningDeadlineFired(entry, deadline);
        },
      );
      if (typeof cancel !== "function") {
        throw new Error("invalid Relay v2 authorization-expiry cancellation receipt");
      }
      deadline.cancel = cancel;
      deadline.armed = true;
    } catch {
      if (entry.warningDeadline === deadline) {
        entry.warningDeadline = null;
        entry.warningJti = null;
        entry.warningExpiresAtMs = null;
      }
      return this.requestSeal();
    }
    if (deadline.firedBeforeArmed) this.warningDeadlineFired(entry, deadline);
  }

  private warningDeadlineFired(entry: Entry, deadline: Deadline): void {
    if (!this.isCurrent(entry) || entry.warningDeadline !== deadline) return;
    const expectedJti = entry.warningJti;
    const expectedExpiresAtMs = entry.warningExpiresAtMs;
    entry.warningDeadline = null;
    deadline.armed = false;
    const cancel = deadline.cancel;
    deadline.cancel = null;
    if (cancel) {
      try {
        Reflect.apply(cancel, undefined, []);
      } catch {
        void this.requestSeal();
        return;
      }
    }
    if (entry.warningFired || expectedJti === null || expectedExpiresAtMs === null) return;
    entry.warningFired = true;
    const attemptGeneration = (entry.warningAttemptGeneration += 1);
    const port = entry.warningPort;
    if (!port) return;
    let raw: unknown;
    try {
      raw = Reflect.apply(port.emitHostAuthExpiring, port.receiver, [
        expectedJti,
        expectedExpiresAtMs,
      ]);
    } catch {
      void this.requestSeal();
      return;
    }
    void Promise.resolve(raw).then((value) => {
      // Attempt fence: current entry + exact identity + exact attempt
      // generation must all match; a refresh/retire makes any late result
      // (including not_due/closed/expired) a plain no-op.
      if (
        !this.isCurrent(entry)
        || entry.warningJti !== expectedJti
        || entry.warningExpiresAtMs !== expectedExpiresAtMs
        || entry.warningAttemptGeneration !== attemptGeneration
      ) return;
      const outcome = parseWarningCutOutcome(value);
      // Only serializer/scheduler/decode/authority fail-closed seals the
      // composition. A single-carrier terminal outcome never does.
      if (outcome === null || outcome === "fail_closed") {
        void this.requestSeal();
        return;
      }
      // emitted/deferred are terminal for this exact credential: BrokerCore
      // owns the once marker and any deferred replay.
      if (outcome === "emitted" || outcome === "deferred") return;
      // closed (control backpressure 1013) and expired are normal
      // single-carrier termination; retire this entry only.
      if (outcome === "closed" || outcome === "expired") {
        this.retire(entry);
        return;
      }
      if (outcome === "not_due") {
        entry.warningFired = false;
        entry.warningConsecutiveEarlyFires += 1;
        if (entry.warningConsecutiveEarlyFires >= MAX_CONSECUTIVE_EARLY_FIRES) {
          void this.requestSeal();
          return;
        }
        void this.armWarning(entry, expectedJti, expectedExpiresAtMs);
        return;
      }
      this.resolveStaleWarning(entry, expectedJti, expectedExpiresAtMs, attemptGeneration);
    }, () => {
      // A late rejection from a superseded attempt must not seal either.
      if (
        !this.isCurrent(entry)
        || entry.warningJti !== expectedJti
        || entry.warningExpiresAtMs !== expectedExpiresAtMs
        || entry.warningAttemptGeneration !== attemptGeneration
      ) return;
      void this.requestSeal();
    });
  }

  /**
   * A stale warning cut means the armed identity no longer matches the Core.
   * If the exact same connection now carries an active replacement
   * credential (host.reauthenticate), re-arm BOTH the exact-expiry and the
   * warning timers from the new closed jti+exp via the shared refresh path.
   * Any other staleness (disconnect/supersede/revoke) is normal termination
   * and retires only this entry. The identity fence is re-checked after the
   * recheck so a refresh crossing the recheck still no-ops this attempt.
   */
  private resolveStaleWarning(
    entry: Entry,
    expectedJti: string,
    expectedExpiresAtMs: number,
    attemptGeneration: number,
  ): void {
    let raw: unknown;
    try {
      raw = Reflect.apply(this.cutPort.recheckConnectionAccessExpiry, this.cutPort.receiver, [
        entry.connectionKind,
        entry.connectionId,
        entry.connectionIncarnation,
      ]);
    } catch {
      void this.requestSeal();
      return;
    }
    void Promise.resolve(raw).then((value) => {
      if (
        !this.isCurrent(entry)
        || entry.warningJti !== expectedJti
        || entry.warningExpiresAtMs !== expectedExpiresAtMs
        || entry.warningAttemptGeneration !== attemptGeneration
      ) return;
      const result = parseCutResult(value);
      if (!result || result.outcome === "fail_closed") {
        void this.requestSeal();
        return;
      }
      if (result.outcome === "active") {
        this.refreshEntry(entry);
        return;
      }
      this.retire(entry);
    }, () => {
      if (
        !this.isCurrent(entry)
        || entry.warningJti !== expectedJti
        || entry.warningExpiresAtMs !== expectedExpiresAtMs
        || entry.warningAttemptGeneration !== attemptGeneration
      ) return;
      void this.requestSeal();
    });
  }

  private deadlineFired(entry: Entry, deadline: Deadline): void {
    if (!this.isCurrent(entry) || entry.deadline !== deadline) return;
    entry.deadline = null;
    deadline.armed = false;
    const cancel = deadline.cancel;
    deadline.cancel = null;
    if (cancel) {
      try {
        Reflect.apply(cancel, undefined, []);
      } catch {
        void this.requestSeal();
        return;
      }
    }
    if (entry.admittedCut) {
      entry.pendingFire = true;
      return;
    }
    this.admitCut(entry, true);
  }

  private retire(entry: Entry): void {
    if (entry.state === "retired") return;
    entry.state = "retired";
    entry.pendingFire = false;
    entry.pendingRefresh = false;
    entry.warningAttemptGeneration += 1;
    const registry = this.registryFor(entry.connectionKind);
    if (registry.get(entry.connectionId) === entry) registry.delete(entry.connectionId);
    this.cancel(entry);
  }

  private cancel(entry: Entry): void {
    const deadline = entry.deadline;
    entry.deadline = null;
    const warningDeadline = entry.warningDeadline;
    entry.warningDeadline = null;
    entry.warningJti = null;
    entry.warningExpiresAtMs = null;
    for (const pending of [deadline, warningDeadline]) {
      if (!pending) continue;
      pending.armed = false;
      const cancel = pending.cancel;
      pending.cancel = null;
      if (!cancel) continue;
      try {
        Reflect.apply(cancel, undefined, []);
      } catch {
        void this.requestSeal();
      }
    }
  }

  private requestSeal(): Promise<void> {
    if (this.sealDrain) return this.sealDrain;
    this.sealRequested = true;
    this.accepting = false;
    let resolveSeal!: () => void;
    let rejectSeal!: (error: unknown) => void;
    this.sealDrain = new Promise<void>((resolve, reject) => {
      resolveSeal = resolve;
      rejectSeal = reject;
    });
    void this.sealDrain.catch(() => {});
    for (const entry of [...this.entries]) this.retire(entry);
    let raw: unknown;
    try {
      raw = Reflect.apply(this.cutPort.failClosed, this.cutPort.receiver, []);
    } catch (error) {
      rejectSeal(error);
      return this.sealDrain;
    }
    void Promise.resolve(raw).then(resolveSeal, rejectSeal);
    return this.sealDrain;
  }

  private async drainEntry(entry: Entry): Promise<void> {
    const cut = entry.admittedCut;
    if (cut) await cut;
    if (this.sealRequested && this.sealDrain) await this.sealDrain;
  }
}
