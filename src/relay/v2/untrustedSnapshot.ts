import { types as nodeUtilTypes } from "node:util";

/**
 * Shared defensive-capture helpers for untrusted broker protocol inputs.
 *
 * These are pure functions with no module-level state so they can be safely
 * inlined into every bundle entry that imports them.
 */

/**
 * Returns true when `value` must be treated as a rejected proxy: either it is
 * a Proxy (whose traps may lie about its shape) or probing it threw. Plain
 * primitives and null are never rejected.
 */
export function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

/**
 * Captures an own-data record whose keys are exactly `exactKeys` (same count,
 * no symbol or extra keys, every key a plain data descriptor). Returns a
 * frozen null-prototype record, or null when the shape does not match or the
 * value is a rejected proxy.
 */
export function captureExactDataRecord(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}
