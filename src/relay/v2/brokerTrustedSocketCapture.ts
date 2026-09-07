import { isRejectedProxy } from "./untrustedSnapshot.js";

/**
 * Shared trusted-prototype socket capture for the broker client and host WSS
 * adapters. Both adapters capture the same seven WebSocket methods and four
 * fact descriptors from a trusted prototype, but differ in two ways that are
 * parameterized here:
 *
 * - `trapHardening`: the host wraps Reflect.getOwnPropertyDescriptor and
 *   Reflect.getPrototypeOf in try/catch so a throwing Proxy trap degrades to
 *   undefined/null instead of propagating. The client lets trap exceptions
 *   propagate. Each side keeps its own behavior.
 * - `errors`: the client throws a single branded error; the host throws
 *   descriptive per-case errors. Each side supplies its own factories.
 *
 * No module-level state; safe to inline per bundle entry.
 */

export type CapturedSocketPrototype = Readonly<{
  prototype: object;
  brand: Function;
  on: Function;
  removeListener: Function;
  send: Function;
  pause: Function;
  resume: Function;
  close: Function;
  terminate: Function;
  readyState: PropertyDescriptor;
  protocol: PropertyDescriptor;
  extensions: PropertyDescriptor;
  bufferedAmount: PropertyDescriptor;
}>;

export interface TrustedSocketCaptureErrors {
  descriptorOwner(name: string): Error;
  missingDescriptor(name: string): Error;
  invalidMethod(name: string): Error;
  invalidFact(name: string): Error;
  invalidPrototype(): Error;
  invalidBrand(): Error;
}

export interface TrustedSocketPrototypeCapture {
  captureTrustedPrototype(
    trustedPrototype: unknown,
    trustedSocketBrand: unknown,
  ): CapturedSocketPrototype;
  readTrustedFact(socket: object, descriptor: PropertyDescriptor): unknown;
}

export function createTrustedSocketPrototypeCapture(options: {
  methodNames: readonly string[];
  trapHardening: boolean;
  errors: TrustedSocketCaptureErrors;
}): TrustedSocketPrototypeCapture {
  const { methodNames, trapHardening, errors } = options;

  function captureTrustedDescriptor(
    trustedPrototype: object,
    name: string,
  ): PropertyDescriptor {
    let owner: object | null = trustedPrototype;
    while (owner !== null) {
      if (isRejectedProxy(owner)) throw errors.descriptorOwner(name);
      let descriptor: PropertyDescriptor | undefined;
      if (trapHardening) {
        try {
          descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
        } catch {
          descriptor = undefined;
        }
      } else {
        descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
      }
      if (descriptor !== undefined) return Object.freeze({ ...descriptor });
      if (trapHardening) {
        try {
          owner = Reflect.getPrototypeOf(owner);
        } catch {
          owner = null;
        }
      } else {
        owner = Reflect.getPrototypeOf(owner);
      }
    }
    throw errors.missingDescriptor(name);
  }

  function captureTrustedMethod(trustedPrototype: object, name: string): Function {
    const descriptor = captureTrustedDescriptor(trustedPrototype, name);
    if (
      !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function"
      || isRejectedProxy(descriptor.value)
    ) throw errors.invalidMethod(name);
    return descriptor.value;
  }

  function captureTrustedFact(
    trustedPrototype: object,
    name: string,
  ): PropertyDescriptor {
    const descriptor = captureTrustedDescriptor(trustedPrototype, name);
    if (Object.hasOwn(descriptor, "value")) return descriptor;
    if (
      typeof descriptor.get !== "function"
      || descriptor.set !== undefined
      || isRejectedProxy(descriptor.get)
    ) throw errors.invalidFact(name);
    return descriptor;
  }

  function captureTrustedPrototype(
    trustedPrototype: unknown,
    trustedSocketBrand: unknown,
  ): CapturedSocketPrototype {
    if (
      trustedPrototype === null
      || typeof trustedPrototype !== "object"
      || isRejectedProxy(trustedPrototype)
    ) throw errors.invalidPrototype();
    if (typeof trustedSocketBrand !== "function" || isRejectedProxy(trustedSocketBrand)) {
      throw errors.invalidBrand();
    }
    const methods = Object.create(null) as Record<string, Function>;
    for (const name of methodNames) methods[name] = captureTrustedMethod(trustedPrototype, name);
    return Object.freeze({
      prototype: trustedPrototype,
      brand: trustedSocketBrand,
      ...methods,
      readyState: captureTrustedFact(trustedPrototype, "readyState"),
      protocol: captureTrustedFact(trustedPrototype, "protocol"),
      extensions: captureTrustedFact(trustedPrototype, "extensions"),
      bufferedAmount: captureTrustedFact(trustedPrototype, "bufferedAmount"),
    });
  }

  function readTrustedFact(socket: object, descriptor: PropertyDescriptor): unknown {
    if (Object.hasOwn(descriptor, "value")) return descriptor.value;
    return Reflect.apply(descriptor.get as Function, socket, []);
  }

  return { captureTrustedPrototype, readTrustedFact };
}
