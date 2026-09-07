import { types as nodeTypes } from "node:util";

import { isRejectedProxy } from "./untrustedSnapshot.js";
import {
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
  type RelayV2HostCredentialAtomicByteCellTransaction,
} from "./hostCredentialVault.js";

/**
 * Shared guards for the non-native Host credential cell implementations
 * (file cell and local-development cell). The native atomic-file cell
 * intentionally keeps its own captured-intrinsic hardened variants and does
 * not use this module.
 *
 * Depends only on node:util, the vault contract, and the pure
 * untrustedSnapshot helpers — no node:fs/node:path — so the
 * local-development cell keeps its zero-native-module isolation guarantee.
 */

const promisePrototypeThen = Promise.prototype.then;

export { isRejectedProxy as rejectedProxy };

/**
 * Copies a replacement envelope, rejecting proxies and oversize payloads.
 * `onInvalid` supplies the cell-specific branded error.
 */
export function copyReplacement(value: unknown, onInvalid: () => Error): Uint8Array {
  if (!(value instanceof Uint8Array)
    || isRejectedProxy(value)
    || value.byteLength > RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES) {
    throw onInvalid();
  }
  return Uint8Array.from(value);
}

/**
 * Returns true when `value` is a Promise or thenable that must not be
 * assimilated: a Promise (whose then we probe), a Proxy, or any object with
 * a then accessor or method. Any throw during probing is treated as
 * asynchronous (rejected).
 */
export function isAsynchronousResultWithoutAssimilation(value: unknown): boolean {
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
 * Runs `operation` exclusively against the cell's transaction, enforcing
 * lifecycle, reentrancy, and synchronous-result guards. `failure` supplies
 * the cell-specific branded errors; `setActive` toggles the cell's
 * reentrancy flag.
 */
export function runCredentialCellExclusive<T>(options: {
  lifecycle: "open" | "closed";
  active: boolean;
  transaction: RelayV2HostCredentialAtomicByteCellTransaction;
  operation: (value: RelayV2HostCredentialAtomicByteCellTransaction) => T;
  failure: (code: "CLOSED" | "REENTRANT" | "OPERATION_INVALID" | "ASYNC_OPERATION_UNSUPPORTED") => Error;
  setActive: (value: boolean) => void;
}): T {
  const { lifecycle, active, transaction, operation, failure, setActive } = options;
  if (lifecycle !== "open") throw failure("CLOSED");
  if (active) throw failure("REENTRANT");
  if (typeof operation !== "function"
    || isRejectedProxy(operation)
    || nodeTypes.isAsyncFunction(operation)) throw failure("OPERATION_INVALID");
  setActive(true);
  try {
    const result = Reflect.apply(operation, undefined, [transaction]) as T;
    if (isAsynchronousResultWithoutAssimilation(result)) {
      throw failure("ASYNC_OPERATION_UNSUPPORTED");
    }
    return result;
  } finally {
    setActive(false);
  }
}
