import { types as nodeTypes } from "node:util";

import {
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
  type RelayV2HostCredentialAtomicByteCellCasResult,
  type RelayV2HostCredentialAtomicByteCellRead,
  type RelayV2HostCredentialAtomicByteCellRevision,
  type RelayV2HostCredentialAtomicByteCellTransaction,
} from "./hostCredentialVault.js";
import type {
  RelayV2HostCredentialAtomicByteCellOwner,
} from "./hostPrivilegedProductionIntakeComposition.js";

const promisePrototypeThen = Promise.prototype.then;

export type RelayV2HostLocalDevelopmentCredentialCellErrorCode =
  | "OPERATION_INVALID"
  | "REVISION_INVALID"
  | "REPLACEMENT_INVALID"
  | "REENTRANT"
  | "ASYNC_OPERATION_UNSUPPORTED"
  | "CLOSED";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostLocalDevelopmentCredentialCellErrorCode,
string
>> = Object.freeze({
  OPERATION_INVALID: "Relay v2 Host local-development credential cell operation is invalid",
  REVISION_INVALID: "Relay v2 Host local-development credential cell revision is invalid",
  REPLACEMENT_INVALID:
    "Relay v2 Host local-development credential cell replacement is invalid",
  REENTRANT: "Relay v2 Host local-development credential cell rejects reentrant access",
  ASYNC_OPERATION_UNSUPPORTED:
    "Relay v2 Host local-development credential cell operation must be synchronous",
  CLOSED: "Relay v2 Host local-development credential cell is closed",
});

export class RelayV2HostLocalDevelopmentCredentialCellError extends Error {
  constructor(readonly code: RelayV2HostLocalDevelopmentCredentialCellErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostLocalDevelopmentCredentialCellError";
  }
}

interface RevisionRecord {
  readonly owner: object;
  readonly generation: number;
  consumed: boolean;
}

function failure(
  code: RelayV2HostLocalDevelopmentCredentialCellErrorCode,
): RelayV2HostLocalDevelopmentCredentialCellError {
  return new RelayV2HostLocalDevelopmentCredentialCellError(code);
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function copyReplacement(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)
    || rejectedProxy(value)
    || value.byteLength > RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES) {
    throw failure("REPLACEMENT_INVALID");
  }
  return Uint8Array.from(value);
}

function isAsynchronousResultWithoutAssimilation(value: unknown): boolean {
  if (nodeTypes.isPromise(value)) {
    try {
      void promisePrototypeThen.call(value, undefined, () => undefined);
    } catch {
      return true;
    }
    return true;
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  let current: object | null = value as object;
  try {
    while (current !== null) {
      if (nodeTypes.isProxy(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, "then");
      if (descriptor !== undefined) {
        return descriptor.get !== undefined || typeof descriptor.value === "function";
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Process-local, non-durable atomic cell used only by the explicit
 * local-development Host activation. It implements the Vault's narrow
 * synchronous cell port without opening a path, native module, qualification
 * source, or fallback. Every process starts empty and close permanently
 * discards its only byte copy.
 */
export function createRelayV2HostLocalDevelopmentCredentialCell(
): RelayV2HostCredentialAtomicByteCellOwner {
  const owner = Object.freeze(Object.create(null));
  const revisions = new WeakMap<object, RevisionRecord>();
  let bytes: Uint8Array | null = null;
  let generation = 0;
  let lifecycle: "open" | "closed" = "open";
  let active = false;
  let closePromise: Promise<void> | null = null;

  const requireOperationOpen = (): void => {
    if (lifecycle !== "open") throw failure("CLOSED");
    if (!active) throw failure("OPERATION_INVALID");
  };
  const read = (): RelayV2HostCredentialAtomicByteCellRead => {
    requireOperationOpen();
    const revision = Object.freeze(Object.create(null));
    revisions.set(revision, { owner, generation, consumed: false });
    return Object.freeze({
      bytes: bytes === null ? null : Uint8Array.from(bytes),
      revision,
    });
  };
  const compareAndSwap = (
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    replacement: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult => {
    requireOperationOpen();
    if (expected === null || typeof expected !== "object" || rejectedProxy(expected)) {
      throw failure("REVISION_INVALID");
    }
    const revision = revisions.get(expected as object);
    if (revision === undefined || revision.owner !== owner || revision.consumed) {
      throw failure("REVISION_INVALID");
    }
    revision.consumed = true;
    const copied = copyReplacement(replacement);
    if (revision.generation !== generation) {
      return Object.freeze({ status: "conflict", current: read() });
    }
    bytes = copied;
    generation += 1;
    return Object.freeze({ status: "swapped" });
  };
  const transaction = Object.freeze(Object.assign(Object.create(null), {
    read,
    compareAndSwap,
  })) as RelayV2HostCredentialAtomicByteCellTransaction;

  const runExclusive = <T>(
    operation: (value: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T => {
    if (lifecycle !== "open") throw failure("CLOSED");
    if (active) throw failure("REENTRANT");
    if (typeof operation !== "function"
      || rejectedProxy(operation)
      || nodeTypes.isAsyncFunction(operation)) throw failure("OPERATION_INVALID");
    active = true;
    try {
      const result = Reflect.apply(operation, undefined, [transaction]) as T;
      if (isAsynchronousResultWithoutAssimilation(result)) {
        throw failure("ASYNC_OPERATION_UNSUPPORTED");
      }
      return result;
    } finally {
      active = false;
    }
  };
  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    lifecycle = "closed";
    bytes = null;
    closePromise = Promise.resolve();
    return closePromise;
  };

  return Object.freeze(Object.assign(Object.create(null), {
    runExclusive,
    closeAndDrain,
  })) as RelayV2HostCredentialAtomicByteCellOwner;
}
