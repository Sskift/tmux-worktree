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
}

type CapturedCutPort = {
  receiver: object;
  recheckConnectionAccessExpiry: (...args: unknown[]) => unknown;
  failClosed: (...args: unknown[]) => unknown;
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
};

const MAX_CONSECUTIVE_EARLY_FIRES = 2;

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

function parseCutResult(value: unknown): RelayV2BrokerConnectionAccessExpiryResult | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return null;
    const outcomeDescriptor = Reflect.getOwnPropertyDescriptor(value, "outcome");
    if (!outcomeDescriptor || !("value" in outcomeDescriptor)) return null;
    const outcome = outcomeDescriptor.value;
    if (outcome === "active") {
      if (keys.length !== 2 || !keys.includes("expiresAtMs")) return null;
      const expiresDescriptor = Reflect.getOwnPropertyDescriptor(value, "expiresAtMs");
      if (
        !expiresDescriptor
        || !("value" in expiresDescriptor)
        || !Number.isSafeInteger(expiresDescriptor.value)
        || expiresDescriptor.value < 0
      ) return null;
      return Object.freeze({ outcome, expiresAtMs: expiresDescriptor.value as number });
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
  ): RelayV2BrokerAuthorizationExpiryDeadlineRegistration {
    if (
      !this.accepting
      || this.closed
      || (connectionKind !== "client" && connectionKind !== "host")
      || !isIdentifier(connectionId)
      || !isIdentifier(connectionIncarnation)
    ) {
      throw new Error("Relay v2 authorization-expiry deadline owner is unavailable");
    }
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
    });
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
    return this.arm(entry, result.expiresAtMs);
  }

  private arm(entry: Entry, expiresAtMs: number): void | Promise<void> {
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
    const registry = this.registryFor(entry.connectionKind);
    if (registry.get(entry.connectionId) === entry) registry.delete(entry.connectionId);
    this.cancel(entry);
  }

  private cancel(entry: Entry): void {
    const deadline = entry.deadline;
    entry.deadline = null;
    if (!deadline) return;
    deadline.armed = false;
    const cancel = deadline.cancel;
    deadline.cancel = null;
    if (!cancel) return;
    try {
      Reflect.apply(cancel, undefined, []);
    } catch {
      void this.requestSeal();
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
