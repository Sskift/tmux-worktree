import { randomUUID } from "node:crypto";

import type {
  RelayV2LiveAuthorizationCloseReason,
  RelayV2LiveAuthorizationCloseSignal,
} from "./brokerCore.js";

const CREDENTIAL_FENCE_CLOSE_DEADLINE_MS = 5_000;

type RelayV2TransportConnectionKind = "client" | "host";
type RelayV2CredentialFenceCloseCode = 1013 | 4401 | 4403;

export type RelayV2BrokerTransportSocket =
  | {
      connectionKind: "client";
      connectionId: string;
      close(code: RelayV2CredentialFenceCloseCode, reason: RelayV2LiveAuthorizationCloseReason): unknown;
      forceDestroy(): unknown;
    }
  | {
      connectionKind: "host";
      transportId: string;
      close(code: RelayV2CredentialFenceCloseCode, reason: RelayV2LiveAuthorizationCloseReason): unknown;
      forceDestroy(): unknown;
    };

export interface RelayV2BrokerTransportSocketRegistration {
  /** Pass this exact value into the matching BrokerCore attach/open call. */
  readonly connectionIncarnation: string;
  /** Call only after the underlying socket has actually terminated. */
  unregister(): void;
}

declare const relayV2BrokerTransportCloseLeaseBrand: unique symbol;

/**
 * Process-local proof that the close coordinator, rather than a caller,
 * selected the exact socket incarnation. Its facts are available only through
 * the brand-checked consume operation below.
 */
export type RelayV2BrokerTransportCloseLease = Readonly<{
  readonly [relayV2BrokerTransportCloseLeaseBrand]: true;
}>;

export interface RelayV2BrokerManagedTransportSocketRegistration {
  readonly lease: RelayV2BrokerTransportCloseLease;
  readonly connectionIncarnation: string;
}

export interface RelayV2BrokerTransportCloseDeadlineScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

type SocketEntry = {
  connectionKind: RelayV2TransportConnectionKind;
  connectionId: string;
  connectionIncarnation: string;
  close: (
    code: RelayV2CredentialFenceCloseCode,
    reason: RelayV2LiveAuthorizationCloseReason,
  ) => unknown;
  forceDestroy: () => unknown;
  state: "open" | "closing" | "destroyed" | "unregistered";
  closeRequested: boolean;
  forceDestroyRequested: boolean;
  deadlineInstalled: boolean;
  deadlineHandle: unknown;
};

type ParsedCloseSignal = {
  connectionKind: RelayV2TransportConnectionKind;
  connectionId: string;
  connectionIncarnation: string;
  reason: RelayV2LiveAuthorizationCloseReason;
};

type ManagedLeaseState = {
  readonly owner: RelayV2BrokerTransportCloseCoordinator;
  readonly entry: SocketEntry;
  claimed: boolean;
  terminal: boolean;
};

const managedLeaseStates = new WeakMap<object, ManagedLeaseState>();

const defaultDeadlineScheduler: RelayV2BrokerTransportCloseDeadlineScheduler = Object.freeze({
  schedule(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function isCloseReason(value: unknown): value is RelayV2LiveAuthorizationCloseReason {
  return value === "access_expired"
    || value === "grant_revoked"
    || value === "kid_removed"
    || value === "credential_authority_unavailable"
    || value === "host_authorization_fenced";
}

function parseCloseSignal(signal: unknown): ParsedCloseSignal | null {
  if (signal === null || typeof signal !== "object") return null;
  const connectionKind = ownDataValue(signal, "connectionKind");
  const connectionIncarnation = ownDataValue(signal, "connectionIncarnation");
  const reason = ownDataValue(signal, "reason");
  if (
    (connectionKind !== "client" && connectionKind !== "host")
    || !isIdentifier(connectionIncarnation)
    || !isCloseReason(reason)
  ) return null;
  const connectionId = ownDataValue(
    signal,
    connectionKind === "client" ? "connectionId" : "transportId",
  );
  if (!isIdentifier(connectionId)) return null;
  return { connectionKind, connectionId, connectionIncarnation, reason };
}

function closeCodeFor(
  reason: RelayV2LiveAuthorizationCloseReason,
): RelayV2CredentialFenceCloseCode {
  switch (reason) {
    case "access_expired":
      return 4401;
    case "grant_revoked":
    case "kid_removed":
      return 4403;
    case "credential_authority_unavailable":
    case "host_authorization_fenced":
      return 1013;
  }
}

/**
 * One-shot managed transport claim. The transport receives no caller-selected
 * incarnation and a lease cannot be replayed for a replacement connection.
 */
export function consumeRelayV2BrokerClientTransportCloseLease(
  lease: RelayV2BrokerTransportCloseLease,
  connectionId: string,
): string {
  if (lease === null || typeof lease !== "object" || !isIdentifier(connectionId)) {
    throw new Error("invalid Relay v2 Broker client transport close lease");
  }
  const state = managedLeaseStates.get(lease);
  if (
    !state
    || state.claimed
    || state.terminal
    || state.entry.connectionKind !== "client"
    || state.entry.connectionId !== connectionId
    || state.entry.state === "unregistered"
  ) {
    throw new Error("stale Relay v2 Broker client transport close lease");
  }
  state.claimed = true;
  return state.entry.connectionIncarnation;
}

/**
 * Unwired transport owner for Relay v2 credential-fence close delivery.
 * BrokerCore has already synchronously fenced business admission/data before
 * it emits the signal consumed here; socket close work always starts later.
 */
export class RelayV2BrokerTransportCloseCoordinator {
  private readonly clients = new Map<string, SocketEntry>();
  private readonly hosts = new Map<string, SocketEntry>();
  private readonly deadlineScheduler: RelayV2BrokerTransportCloseDeadlineScheduler;

  constructor(options: {
    deadlineScheduler?: RelayV2BrokerTransportCloseDeadlineScheduler;
  } = {}) {
    this.deadlineScheduler = options.deadlineScheduler ?? defaultDeadlineScheduler;
  }

  registerSocket(
    socket: RelayV2BrokerTransportSocket,
  ): RelayV2BrokerTransportSocketRegistration {
    const entry = this.registerEntry(socket);
    const registry = this.registryFor(entry.connectionKind);
    return Object.freeze({
      connectionIncarnation: entry.connectionIncarnation,
      unregister: () => {
        if (entry.state === "unregistered") return;
        entry.state = "unregistered";
        if (registry.get(entry.connectionId) === entry) registry.delete(entry.connectionId);
        this.cancelDeadline(entry);
      },
    });
  }

  registerManagedClientSocket(
    socket: Extract<RelayV2BrokerTransportSocket, { connectionKind: "client" }>,
  ): RelayV2BrokerManagedTransportSocketRegistration {
    const entry = this.registerEntry(socket);
    const lease = Object.freeze(Object.create(null)) as RelayV2BrokerTransportCloseLease;
    managedLeaseStates.set(lease, {
      owner: this,
      entry,
      claimed: false,
      terminal: false,
    });
    return Object.freeze({
      lease,
      connectionIncarnation: entry.connectionIncarnation,
    });
  }

  /**
   * Force-destroy is only a request. The managed registration remains current
   * until terminalAndUnregisterManagedSocket observes a real adapter terminal.
   */
  forceDestroyManagedSocket(lease: RelayV2BrokerTransportCloseLease): boolean {
    const state = this.managedLeaseState(lease);
    if (!state || state.terminal) return false;
    this.forceDestroy(state.entry);
    return true;
  }

  terminalAndUnregisterManagedSocket(lease: RelayV2BrokerTransportCloseLease): boolean {
    const state = this.managedLeaseState(lease);
    if (!state || !state.claimed) return false;
    if (state.terminal) return true;
    state.terminal = true;
    const { entry } = state;
    entry.state = "unregistered";
    const registry = this.registryFor(entry.connectionKind);
    if (registry.get(entry.connectionId) === entry) registry.delete(entry.connectionId);
    this.cancelDeadline(entry);
    return true;
  }

  /**
   * Returns true only when the signal exact-matches the currently registered
   * kind, transport ID and incarnation. Duplicate matching signals are
   * absorbed without issuing another close.
   */
  handleLiveAuthorizationClose(
    signal: RelayV2LiveAuthorizationCloseSignal,
  ): boolean {
    const parsed = parseCloseSignal(signal);
    if (!parsed) return false;
    const entry = this.registryFor(parsed.connectionKind).get(parsed.connectionId);
    if (
      !entry
      || entry.connectionIncarnation !== parsed.connectionIncarnation
      || entry.state === "unregistered"
    ) return false;
    if (entry.state === "closing" || entry.state === "destroyed") return true;

    entry.state = "closing";
    entry.deadlineInstalled = true;
    let deadlineHandle: unknown;
    try {
      deadlineHandle = this.deadlineScheduler.schedule(() => {
        entry.deadlineInstalled = false;
        entry.deadlineHandle = undefined;
        this.forceDestroy(entry);
      }, CREDENTIAL_FENCE_CLOSE_DEADLINE_MS);
    } catch {
      entry.deadlineInstalled = false;
      entry.deadlineHandle = undefined;
      this.forceDestroy(entry);
      return true;
    }
    if (entry.state !== "closing" || !entry.deadlineInstalled) {
      this.cancelReturnedDeadline(deadlineHandle);
      return true;
    }
    entry.deadlineHandle = deadlineHandle;

    try {
      queueMicrotask(() => {
        this.requestClose(entry, parsed.reason);
      });
    } catch {
      this.forceDestroy(entry);
    }
    return true;
  }

  private registryFor(connectionKind: RelayV2TransportConnectionKind): Map<string, SocketEntry> {
    return connectionKind === "client" ? this.clients : this.hosts;
  }

  private registerEntry(socket: RelayV2BrokerTransportSocket): SocketEntry {
    const connectionKind = socket.connectionKind;
    if (connectionKind !== "client" && connectionKind !== "host") {
      throw new Error("invalid Relay v2 transport socket connection kind");
    }
    const connectionId = connectionKind === "client" ? socket.connectionId : socket.transportId;
    const close = socket.close;
    const forceDestroy = socket.forceDestroy;
    if (
      !isIdentifier(connectionId)
      || typeof close !== "function"
      || typeof forceDestroy !== "function"
    ) {
      throw new Error("invalid Relay v2 transport socket registration");
    }
    const registry = this.registryFor(connectionKind);
    if (registry.has(connectionId)) {
      throw new Error("duplicate Relay v2 transport socket registration");
    }
    const entry: SocketEntry = {
      connectionKind,
      connectionId,
      connectionIncarnation: randomUUID(),
      close: (code, reason) => Reflect.apply(close, socket, [code, reason]),
      forceDestroy: () => Reflect.apply(forceDestroy, socket, []),
      state: "open",
      closeRequested: false,
      forceDestroyRequested: false,
      deadlineInstalled: false,
      deadlineHandle: undefined,
    };
    registry.set(connectionId, entry);
    return entry;
  }

  private managedLeaseState(
    lease: RelayV2BrokerTransportCloseLease,
  ): ManagedLeaseState | undefined {
    if (lease === null || typeof lease !== "object") return undefined;
    const state = managedLeaseStates.get(lease);
    return state?.owner === this ? state : undefined;
  }

  private requestClose(entry: SocketEntry, reason: RelayV2LiveAuthorizationCloseReason): void {
    if (entry.state !== "closing" || entry.closeRequested) return;
    entry.closeRequested = true;
    try {
      const result = entry.close(closeCodeFor(reason), reason);
      void Promise.resolve(result).catch(() => {
        this.forceDestroy(entry);
      });
    } catch {
      this.forceDestroy(entry);
    }
  }

  private forceDestroy(entry: SocketEntry): void {
    if (entry.state === "unregistered" || entry.forceDestroyRequested) return;
    entry.forceDestroyRequested = true;
    entry.state = "destroyed";
    this.cancelDeadline(entry);
    try {
      const result = entry.forceDestroy();
      void Promise.resolve(result).catch(() => {});
    } catch {
      // A transport destroy failure cannot reopen the fenced broker or block
      // independent sockets from reaching their own deadline.
    }
  }

  private cancelDeadline(entry: SocketEntry): void {
    if (!entry.deadlineInstalled) return;
    entry.deadlineInstalled = false;
    const handle = entry.deadlineHandle;
    entry.deadlineHandle = undefined;
    try {
      this.deadlineScheduler.cancel(handle);
    } catch {
      // A scheduler cleanup failure must not escape into BrokerCore's signal
      // callback or interfere with another registered socket.
    }
  }

  private cancelReturnedDeadline(handle: unknown): void {
    try {
      this.deadlineScheduler.cancel(handle);
    } catch {
      // A synchronously fired scheduler may return an already-expired handle;
      // cleanup remains best-effort and never revives close delivery.
    }
  }
}
