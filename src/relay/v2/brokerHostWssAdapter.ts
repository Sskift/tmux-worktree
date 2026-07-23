import { types as nodeUtilTypes } from "node:util";

export const RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES = 1_500_000;

export type RelayV2BrokerHostWssTerminalEvidence = Readonly<
  | { kind: "closed"; code: number }
  | { kind: "errored" }
>;

export interface RelayV2BrokerHostWssSocket {
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  send(
    data: string,
    options: Readonly<{ binary: false; compress: false }>,
    callback: (error?: Error) => void,
  ): unknown;
  pause(): unknown;
  resume(): unknown;
  close(code: number, reason: string): unknown;
  terminate(): unknown;
}

export type RelayV2BrokerHostWssInboundFrame = Readonly<{
  bytes: Uint8Array;
}>;

export type RelayV2BrokerHostWssAdapterHandlers = Readonly<{
  message(frame: RelayV2BrokerHostWssInboundFrame): void;
  invalidFrame(reason: "binary" | "oversize" | "invalid"): void;
  terminal(evidence: RelayV2BrokerHostWssTerminalEvidence): void;
}>;

export interface RelayV2BrokerHostWssAdapter {
  validate(): "applied" | "rejected";
  install(handlers: RelayV2BrokerHostWssAdapterHandlers): void;
  send(
    bytes: Uint8Array,
    complete: (receipt: "delivered" | "rejected") => void,
  ): "applied" | "rejected";
  pause(): "applied" | "rejected";
  resume(): "applied" | "rejected";
  close(code: number, reason: string): "applied" | "rejected";
  forceDestroy(): "applied" | "rejected";
  bufferedAmount(): number | null;
  cleanup(): void;
}

export interface RelayV2BrokerHostWssCaptureAuthority {
  capture(socket: RelayV2BrokerHostWssSocket): RelayV2BrokerHostWssAdapter;
}

export type RelayV2BrokerHostWssTrustedSocketBrand = (
  socket: RelayV2BrokerHostWssSocket,
) => boolean;

type CapturedSocket = Readonly<{
  receiver: object;
  on: Function;
  removeListener: Function;
  send: Function;
  pause: Function;
  resume: Function;
  close: Function;
  terminate: Function;
  readReadyState(): unknown;
  readProtocol(): unknown;
  readExtensions(): unknown;
  readBufferedAmount(): unknown;
}>;

type CapturedSocketPrototype = Readonly<{
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

function closedError(): Error {
  return new Error("Relay v2 Broker Host WSS closed");
}

function captureHandlers(value: unknown): RelayV2BrokerHostWssAdapterHandlers {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) {
    throw new Error("invalid Relay v2 Broker Host WSS adapter handlers");
  }
  const expected = ["message", "invalidFrame", "terminal"];
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error("invalid Relay v2 Broker Host WSS adapter handlers");
  }
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    throw new Error("invalid Relay v2 Broker Host WSS adapter handlers");
  }
  const methods = Object.create(null) as Record<string, Function>;
  for (const key of expected) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "function"
      || rejectedProxy(descriptor.value)
    ) {
      throw new Error("invalid Relay v2 Broker Host WSS adapter handlers");
    }
    methods[key] = descriptor.value;
  }
  return Object.freeze({
    message: (frame) => Reflect.apply(methods.message!, value, [frame]),
    invalidFrame: (reason) => Reflect.apply(methods.invalidFrame!, value, [reason]),
    terminal: (evidence) => Reflect.apply(methods.terminal!, value, [evidence]),
  });
}

const METHOD_NAMES = Object.freeze([
  "on",
  "removeListener",
  "send",
  "pause",
  "resume",
  "close",
  "terminate",
] as const);

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function captureTrustedDescriptor(
  trustedPrototype: object,
  name: string,
): PropertyDescriptor {
  let owner: object | null = trustedPrototype;
  while (owner !== null) {
    if (rejectedProxy(owner)) {
      throw new Error(`invalid Relay v2 Broker Host WSS ${name} descriptor owner`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
    } catch {
      descriptor = undefined;
    }
    if (descriptor !== undefined) {
      return Object.freeze({ ...descriptor });
    }
    try {
      owner = Reflect.getPrototypeOf(owner);
    } catch {
      owner = null;
    }
  }
  throw new Error(`missing Relay v2 Broker Host WSS ${name} descriptor`);
}

function captureTrustedMethod(
  trustedPrototype: object,
  name: typeof METHOD_NAMES[number],
): Function {
  const descriptor = captureTrustedDescriptor(trustedPrototype, name);
  if (
    !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "function"
    || rejectedProxy(descriptor.value)
  ) {
    throw new Error(`invalid Relay v2 Broker Host WSS ${name} method`);
  }
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
    || rejectedProxy(descriptor.get)
  ) {
    throw new Error(`invalid Relay v2 Broker Host WSS ${name} fact`);
  }
  return descriptor;
}

function captureTrustedPrototype(
  trustedPrototype: unknown,
  trustedSocketBrand: unknown,
): CapturedSocketPrototype {
  if (
    trustedPrototype === null
    || typeof trustedPrototype !== "object"
    || rejectedProxy(trustedPrototype)
  ) {
    throw new Error("invalid Relay v2 Broker Host WSS trusted prototype");
  }
  if (typeof trustedSocketBrand !== "function" || rejectedProxy(trustedSocketBrand)) {
    throw new Error("invalid Relay v2 Broker Host WSS trusted socket brand");
  }
  const methods = Object.create(null) as Record<typeof METHOD_NAMES[number], Function>;
  for (const name of METHOD_NAMES) methods[name] = captureTrustedMethod(trustedPrototype, name);
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

function readTrustedFact(
  socket: object,
  descriptor: PropertyDescriptor,
): unknown {
  if (Object.hasOwn(descriptor, "value")) return descriptor.value;
  return Reflect.apply(descriptor.get as Function, socket, []);
}

function captureSocket(
  socket: unknown,
  trusted: CapturedSocketPrototype,
): CapturedSocket {
  if (socket === null || typeof socket !== "object" || rejectedProxy(socket)) {
    throw closedError();
  }
  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(socket);
  } catch {
    throw closedError();
  }
  if (prototype !== trusted.prototype) {
    throw closedError();
  }
  let branded = false;
  try {
    branded = Reflect.apply(trusted.brand, undefined, [socket]) === true;
  } catch {
    branded = false;
  }
  if (!branded) {
    throw closedError();
  }
  const readReadyState = () => readTrustedFact(socket, trusted.readyState);
  const readProtocol = () => readTrustedFact(socket, trusted.protocol);
  const readExtensions = () => readTrustedFact(socket, trusted.extensions);
  const readBufferedAmount = () => readTrustedFact(socket, trusted.bufferedAmount);
  return Object.freeze({
    receiver: socket,
    on: trusted.on,
    removeListener: trusted.removeListener,
    send: trusted.send,
    pause: trusted.pause,
    resume: trusted.resume,
    close: trusted.close,
    terminate: trusted.terminate,
    readReadyState,
    readProtocol,
    readExtensions,
    readBufferedAmount,
  });
}

type CopyTextFrameResult = Readonly<
  | { outcome: "accepted"; frame: RelayV2BrokerHostWssInboundFrame }
  | { outcome: "binary" | "oversize" | "invalid" }
>;

function copyTextFrame(data: unknown, isBinary: unknown): CopyTextFrameResult {
  if (isBinary !== false) return Object.freeze({ outcome: "binary" });
  if (rejectedProxy(data)) return Object.freeze({ outcome: "invalid" });
  let source: Uint8Array;
  try {
    if (typeof data === "string") {
      const bytes = Buffer.byteLength(data, "utf8");
      if (bytes > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
        return Object.freeze({ outcome: "oversize" });
      }
      source = Buffer.from(data, "utf8");
    } else if (Buffer.isBuffer(data)) {
      if (data.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
        return Object.freeze({ outcome: "oversize" });
      }
      source = Uint8Array.from(data);
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
        return Object.freeze({ outcome: "oversize" });
      }
      source = new Uint8Array(data.slice(0));
    } else if (Array.isArray(data) && Reflect.getPrototypeOf(data) === Array.prototype) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(data, "length");
      const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, "value")
        ? lengthDescriptor.value
        : undefined;
      if (
        typeof length !== "number"
        || !Number.isSafeInteger(length)
        || length < 0
        || length > 1_024
      ) {
        return Object.freeze({ outcome: "invalid" });
      }
      const keys = Reflect.ownKeys(data);
      if (keys.length !== length + 1 || !keys.includes("length")) {
        return Object.freeze({ outcome: "invalid" });
      }
      const parts: Buffer[] = [];
      let total = 0;
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(data, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !Buffer.isBuffer(descriptor.value)) {
          return Object.freeze({ outcome: "invalid" });
        }
        if (descriptor.value.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES - total) {
          return Object.freeze({ outcome: "oversize" });
        }
        total += descriptor.value.byteLength;
        parts.push(descriptor.value);
      }
      source = Buffer.concat(parts, total);
    } else if (ArrayBuffer.isView(data)) {
      if (data.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
        return Object.freeze({ outcome: "oversize" });
      }
      source = Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      return Object.freeze({ outcome: "invalid" });
    }
  } catch {
    return Object.freeze({ outcome: "invalid" });
  }
  if (source.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES) {
    return Object.freeze({ outcome: "oversize" });
  }
  return Object.freeze({
    outcome: "accepted",
    frame: Object.freeze({ bytes: source }),
  });
}

function safeCloseCode(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65_535
    ? value as number
    : 1006;
}

class RelayV2BrokerHostWssAdapterImpl implements RelayV2BrokerHostWssAdapter {
  private installed = false;
  private installing = false;
  private reentrantInstall = false;
  private terminal = false;
  private forceSucceeded = false;
  private callbackActive = false;
  private handlers: RelayV2BrokerHostWssAdapterHandlers | null = null;
  private readonly ownedListeners: Array<readonly [string, Function]> = [];
  private readonly messageListener: (data: unknown, isBinary: unknown) => void;
  private readonly closeListener: (code: unknown) => void;
  private readonly errorListener: () => void;

  constructor(private readonly socket: CapturedSocket) {
    const owner = this;
    this.messageListener = function message(
      this: unknown,
      data: unknown,
      isBinary: unknown,
    ): void {
      owner.acceptMessage(this, data, isBinary);
    };
    this.closeListener = function close(this: unknown, code: unknown): void {
      owner.acceptClose(this, code);
    };
    this.errorListener = function error(this: unknown): void {
      owner.acceptError(this);
    };
  }

  validate(): "applied" | "rejected" {
    try {
      const bufferedAmount = this.socket.readBufferedAmount();
      return this.socket.readReadyState() === 1
        && this.socket.readProtocol() === "tw-relay.host.v2"
        && this.socket.readExtensions() === ""
        && Number.isSafeInteger(bufferedAmount)
        && (bufferedAmount as number) >= 0
        ? "applied"
        : "rejected";
    } catch {
      return "rejected";
    }
  }

  private acceptMessage(receiver: unknown, data: unknown, isBinary: unknown): void {
    if (this.installing) {
      this.reentrantInstall = true;
      return;
    }
    if (!this.installed || this.terminal || this.callbackActive) return;
    if (receiver !== this.socket.receiver) {
      this.handlers!.invalidFrame("invalid");
      return;
    }
    this.callbackActive = true;
    try {
      if (isBinary !== false) {
        this.handlers!.invalidFrame("binary");
        return;
      }
      const copied = copyTextFrame(data, isBinary);
      if (copied.outcome !== "accepted") {
        this.handlers!.invalidFrame(copied.outcome);
        return;
      }
      this.handlers!.message(copied.frame);
    } finally {
      this.callbackActive = false;
    }
  }

  private acceptClose(receiver: unknown, code: unknown): void {
    if (this.installing) {
      this.reentrantInstall = true;
      return;
    }
    if (receiver !== this.socket.receiver) {
      this.handlers?.invalidFrame("invalid");
      return;
    }
    this.finishTerminal(Object.freeze({ kind: "closed", code: safeCloseCode(code) }));
  }

  private acceptError(receiver: unknown): void {
    if (this.installing) {
      this.reentrantInstall = true;
      return;
    }
    if (receiver !== this.socket.receiver) {
      this.handlers?.invalidFrame("invalid");
      return;
    }
    this.finishTerminal(Object.freeze({ kind: "errored" }));
  }

  install(handlers: RelayV2BrokerHostWssAdapterHandlers): void {
    if (this.installed || this.terminal) {
      throw closedError();
    }
    this.handlers = captureHandlers(handlers);
    this.installing = true;
    let failed = false;
    try {
      for (const [event, listener] of [
        ["close", this.closeListener],
        ["error", this.errorListener],
        ["message", this.messageListener],
      ] as const) {
        if (event === "message" && failed) break;
        this.ownedListeners.push([event, listener]);
        try {
          const result = Reflect.apply(this.socket.on, this.socket.receiver, [event, listener]);
          if (result !== this.socket.receiver) {
            throw new Error("Relay v2 Broker Host WSS listener registration was rejected");
          }
        } catch (error) {
          failed = true;
        }
        if (this.reentrantInstall) {
          failed = true;
        }
      }
      if (failed) throw closedError();
      const bufferedAmount = this.socket.readBufferedAmount();
      if (
        this.socket.readReadyState() !== 1
        || this.socket.readProtocol() !== "tw-relay.host.v2"
        || this.socket.readExtensions() !== ""
        || !Number.isSafeInteger(bufferedAmount)
        || (bufferedAmount as number) < 0
      ) {
        throw new Error("Relay v2 Broker Host WSS changed during guard installation");
      }
      this.installed = true;
    } catch (error) {
      try { this.cleanupOwnedListeners(); } catch {}
      this.handlers = null;
      this.installed = false;
      throw closedError();
    } finally {
      this.installing = false;
    }
  }

  send(
    source: Uint8Array,
    complete: (receipt: "delivered" | "rejected") => void,
  ): "applied" | "rejected" {
    let readyState: unknown;
    try { readyState = this.socket.readReadyState(); } catch { return "rejected"; }
    if (
      this.terminal
      || !this.installed
      || rejectedProxy(source)
      || !(source instanceof Uint8Array)
      || source.byteLength > RELAY_V2_BROKER_HOST_WSS_MAX_FRAME_BYTES
      || typeof complete !== "function"
      || rejectedProxy(complete)
      || readyState !== 1
    ) return "rejected";
    const text = Buffer.from(source).toString("utf8");
    let returned = false;
    let callbackObserved = false;
    let callbackSeen = false;
    let callbackReceipt: "delivered" | "rejected" = "rejected";
    let settled = false;
    const settle = (receipt: "delivered" | "rejected"): void => {
      if (settled || this.terminal) return;
      settled = true;
      try {
        complete(receipt);
      } catch {
        this.forceDestroy();
      }
    };
    const callback = (error?: Error | null): void => {
      if (callbackSeen) return;
      callbackSeen = true;
      const receipt = error == null ? "delivered" : "rejected";
      if (!returned) {
        callbackObserved = true;
        callbackReceipt = receipt;
        return;
      }
      settle(receipt);
    };
    let result: unknown;
    try {
      result = Reflect.apply(this.socket.send, this.socket.receiver, [
        text,
        Object.freeze({ binary: false as const, compress: false as const }),
        callback,
      ]);
    } catch {
      returned = true;
      return "rejected";
    }
    returned = true;
    let committedReadyState: unknown;
    let committedProtocol: unknown;
    let committedExtensions: unknown;
    try {
      committedReadyState = this.socket.readReadyState();
      committedProtocol = this.socket.readProtocol();
      committedExtensions = this.socket.readExtensions();
    } catch {
      return "rejected";
    }
    if (
      result !== undefined
      || this.terminal
      || !this.installed
      || committedReadyState !== 1
      || committedProtocol !== "tw-relay.host.v2"
      || committedExtensions !== ""
    ) return "rejected";
    if (callbackObserved) queueMicrotask(() => settle(callbackReceipt));
    return "applied";
  }

  pause(): "applied" | "rejected" {
    return this.invokeNoArgs(this.socket.pause);
  }

  resume(): "applied" | "rejected" {
    return this.invokeNoArgs(this.socket.resume);
  }

  close(code: number, reason: string): "applied" | "rejected" {
    if (this.terminal || !Number.isInteger(code) || typeof reason !== "string") return "rejected";
    try {
      const state = this.socket.readReadyState();
      if (state !== 1 && state !== 2) return "rejected";
      return Reflect.apply(this.socket.close, this.socket.receiver, [code, reason]) === undefined
        ? "applied"
        : "rejected";
    } catch {
      return "rejected";
    }
  }

  forceDestroy(): "applied" | "rejected" {
    if (this.forceSucceeded) return "applied";
    try {
      if (Reflect.apply(this.socket.terminate, this.socket.receiver, []) !== undefined) {
        return "rejected";
      }
      this.forceSucceeded = true;
      return "applied";
    } catch {
      return "rejected";
    }
  }

  bufferedAmount(): number | null {
    try {
      const value = this.socket.readBufferedAmount();
      return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
    } catch {
      return null;
    }
  }

  cleanup(): void {
    this.installed = false;
    this.handlers = null;
    this.cleanupOwnedListeners();
  }

  private cleanupOwnedListeners(): void {
    let failed = false;
    for (let index = this.ownedListeners.length - 1; index >= 0; index -= 1) {
      const [event, listener] = this.ownedListeners[index]!;
      try {
        const result = Reflect.apply(this.socket.removeListener, this.socket.receiver, [event, listener]);
        if (result === this.socket.receiver) {
          this.ownedListeners.splice(index, 1);
        } else {
          failed = true;
        }
      } catch {
        failed = true;
      }
    }
    if (failed) throw closedError();
  }

  private invokeNoArgs(method: Function, allowTerminal = false): "applied" | "rejected" {
    if ((!allowTerminal && this.terminal) || !this.installed) return "rejected";
    try {
      return Reflect.apply(method, this.socket.receiver, []) === undefined
        ? "applied"
        : "rejected";
    } catch {
      return "rejected";
    }
  }

  private finishTerminal(evidence: RelayV2BrokerHostWssTerminalEvidence): void {
    if (this.terminal) return;
    this.terminal = true;
    try { this.handlers?.terminal(evidence); } catch { this.forceDestroy(); }
  }
}

/** Capture-only native adapter. It installs no listener until `install`. */
export function createRelayV2BrokerHostWssAdapter(
  socket: RelayV2BrokerHostWssSocket,
  trustedSocketPrototype: object,
  trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
): RelayV2BrokerHostWssAdapter {
  const trusted = captureTrustedPrototype(trustedSocketPrototype, trustedSocketBrand);
  return new RelayV2BrokerHostWssAdapterImpl(captureSocket(socket, trusted));
}

export function createRelayV2BrokerHostWssCaptureAuthority(
  trustedSocketPrototype: object,
  trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
): RelayV2BrokerHostWssCaptureAuthority {
  const trusted = captureTrustedPrototype(trustedSocketPrototype, trustedSocketBrand);
  return Object.freeze({
    capture: (socket: RelayV2BrokerHostWssSocket) => (
      new RelayV2BrokerHostWssAdapterImpl(captureSocket(socket, trusted))
    ),
  });
}
