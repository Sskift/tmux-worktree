import {
  RelayV2DashboardManagementAuthorityFailure,
  type RelayV2DashboardManagementConnectorCut,
  type RelayV2DashboardManagementConnectorPort,
} from "./relayV2DashboardManagementAuthority.js";
import type { RelayV2DashboardManagementProtocolV2ErrorCode } from
  "./relayV2DashboardManagementProtocolV2.js";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES,
} from "./relayV2DashboardManagementProtocolV2.js";
import {
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
} from "./hostCredentialAuthority.js";
import type {
  RelayV2HostConnectorControllerBinding,
  RelayV2HostConnectorControllerCut,
  RelayV2HostConnectorControllerErrorCode,
  RelayV2HostConnectorControllerIdentity,
  RelayV2HostConnectorControllerPort,
  RelayV2HostConnectorControllerStartInput,
  RelayV2HostConnectorControllerStartResult,
  RelayV2HostConnectorControllerStopInput,
  RelayV2HostConnectorControllerStopResult,
} from "./hostConnectorController.js";
import { isRelayV2AuthIdentifier } from "./token.js";

const MAX_IDENTIFIER_BYTES = 128;
const MAX_COUNTER = 18_446_744_073_709_551_615n;

type MaybePromise<T> = T | Promise<T>;
type DataRecord = Record<string, unknown>;

export interface RelayV2DashboardManagementHostConnectorAdapterOptions {
  readonly controller: RelayV2HostConnectorControllerPort;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
  /** Caller-owned cancellation. This adapter never creates another deadline. */
  readonly signal: AbortSignal;
}

export class RelayV2DashboardManagementHostConnectorAdapterClosedError extends Error {
  constructor() {
    super("Relay v2 Dashboard host connector adapter closed");
    this.name = "RelayV2DashboardManagementHostConnectorAdapterClosedError";
  }
}

interface ParsedControllerCut {
  status: "stopped" | "starting" | "registered" | "failed" | "superseded";
  controllerGeneration: string;
  connectorId: string | null;
  hostId: string | null;
  hostEpoch: string | null;
  hostInstanceId: string | null;
  credentialReference: string | null;
  acknowledgement: "host.registered" | null;
  negotiatedCapabilityIntersection: readonly string[];
  retryable: boolean | null;
}

interface PendingStart {
  requestId: string;
  promise: Promise<void>;
}

function closed(): never {
  throw new RelayV2DashboardManagementHostConnectorAdapterClosedError();
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value)) return closed();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return closed();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) return closed();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function ownData(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function dataMethod(value: unknown, key: string): ((...args: unknown[]) => unknown) | null {
  if (!isObject(value)) return null;
  try {
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (own !== undefined) {
      return Object.hasOwn(own, "value") && typeof own.value === "function"
        ? own.value as (...args: unknown[]) => unknown
        : null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (!isObject(prototype)) return null;
    const inherited = Object.getOwnPropertyDescriptor(prototype, key);
    return inherited !== undefined
      && Object.hasOwn(inherited, "value")
      && typeof inherited.value === "function"
      ? inherited.value as (...args: unknown[]) => unknown
      : null;
  } catch {
    return null;
  }
}

function identifier(value: unknown): string {
  if (!isRelayV2AuthIdentifier(value)
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) return closed();
  return value;
}

function credentialReference(value: unknown): string {
  const reference = identifier(value);
  if (!reference.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || reference.length === RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length) {
    return closed();
  }
  return reference;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function counter(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return closed();
  try {
    if (BigInt(value) > MAX_COUNTER) return closed();
  } catch {
    return closed();
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") return closed();
  return value;
}

function canonicalCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value)
    || value.length > RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.length) {
    return closed();
  }
  const seen = new Set<string>();
  for (const capability of value as unknown[]) {
    if (typeof capability !== "string"
      || !(RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES as readonly string[])
        .includes(capability)
      || seen.has(capability)) return closed();
    seen.add(capability);
  }
  return Object.freeze(RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.filter(
    (capability) => seen.has(capability),
  ));
}

const BINDING_KEYS = Object.freeze([
  "controllerGeneration",
  "connectorId",
  "hostId",
  "hostEpoch",
  "hostInstanceId",
  "credentialReference",
]);

function parseBinding(fields: DataRecord): RelayV2HostConnectorControllerBinding {
  return Object.freeze({
    controllerGeneration: counter(fields.controllerGeneration),
    connectorId: nullableIdentifier(fields.connectorId),
    hostId: identifier(fields.hostId),
    hostEpoch: identifier(fields.hostEpoch),
    hostInstanceId: identifier(fields.hostInstanceId),
    credentialReference: credentialReference(fields.credentialReference),
  });
}

function parseControllerCut(value: unknown): ParsedControllerCut {
  if (!isObject(value)) return closed();
  const status = ownData(value, "status");
  if (status === "stopped") {
    const fields = exactDataObject(value, ["status", "controllerGeneration"]);
    return Object.freeze({
      status,
      controllerGeneration: counter(fields.controllerGeneration),
      connectorId: null,
      hostId: null,
      hostEpoch: null,
      hostInstanceId: null,
      credentialReference: null,
      acknowledgement: null,
      negotiatedCapabilityIntersection: Object.freeze([]),
      retryable: null,
    });
  }
  if (status === "starting" || status === "superseded") {
    const fields = exactDataObject(value, ["status", ...BINDING_KEYS]);
    const binding = parseBinding(fields);
    if (status === "starting" && binding.connectorId !== null) return closed();
    return Object.freeze({
      status,
      ...binding,
      acknowledgement: null,
      negotiatedCapabilityIntersection: Object.freeze([]),
      retryable: null,
    });
  }
  if (status === "failed") {
    const fields = exactDataObject(value, ["status", ...BINDING_KEYS, "retryable"]);
    const binding = parseBinding(fields);
    return Object.freeze({
      status,
      ...binding,
      acknowledgement: null,
      negotiatedCapabilityIntersection: Object.freeze([]),
      retryable: booleanValue(fields.retryable),
    });
  }
  if (status === "registered") {
    const fields = exactDataObject(value, [
      "status",
      ...BINDING_KEYS,
      "acknowledgement",
      "negotiatedCapabilityIntersection",
    ]);
    if (fields.acknowledgement !== "host.registered") return closed();
    const binding = parseBinding(fields);
    if (binding.connectorId === null) return closed();
    return Object.freeze({
      status,
      ...binding,
      acknowledgement: "host.registered",
      negotiatedCapabilityIntersection: canonicalCapabilities(
        fields.negotiatedCapabilityIntersection,
      ),
      retryable: null,
    });
  }
  return closed();
}

function parseRequestId(value: unknown): string {
  const fields = exactDataObject(value, ["requestId"]);
  return identifier(fields.requestId);
}

function parseStartResult(value: unknown): RelayV2HostConnectorControllerStartResult {
  const fields = exactDataObject(value, ["status", "requestId", ...BINDING_KEYS]);
  if (fields.status !== "started") return closed();
  const binding = parseBinding(fields);
  if (binding.connectorId === null) return closed();
  return Object.freeze({
    status: "started",
    requestId: identifier(fields.requestId),
    ...binding,
    connectorId: binding.connectorId,
  });
}

function parseStopResult(value: unknown): RelayV2HostConnectorControllerStopResult {
  const fields = exactDataObject(value, ["status", "requestId", ...BINDING_KEYS]);
  if (fields.status !== "stopped_and_drained") return closed();
  return Object.freeze({
    status: "stopped_and_drained",
    requestId: identifier(fields.requestId),
    ...parseBinding(fields),
  });
}

function controllerErrorCode(
  error: unknown,
): RelayV2HostConnectorControllerErrorCode | null {
  if (ownData(error, "name") !== "RelayV2HostConnectorControllerError") {
    return null;
  }
  const code = ownData(error, "code");
  switch (code) {
    case "ABORTED":
    case "BUSY":
    case "UNAVAILABLE":
    case "SUPERSEDED":
    case "OPERATION_FAILED":
      return code;
    default:
      return null;
  }
}

function mappedProtocolCode(
  error: unknown,
): RelayV2DashboardManagementProtocolV2ErrorCode | null {
  switch (controllerErrorCode(error)) {
    case "BUSY":
      return "BUSY";
    case "UNAVAILABLE":
      return "UNAVAILABLE";
    case "SUPERSEDED":
      return "NOT_READY";
    case "ABORTED":
    case "OPERATION_FAILED":
      return "OPERATION_FAILED";
    default:
      return null;
  }
}

/**
 * Unwired NDM3 adapter. The injected controller remains the only connector
 * lifecycle owner. This adapter retains only fixed bindings, a monotonic
 * observation fence, and one pending start promise; it never owns a child,
 * process, socket, capability producer, retry, or deadline.
 */
export class RelayV2DashboardManagementHostConnectorAdapter
implements RelayV2DashboardManagementConnectorPort {
  private readonly inspectControllerCut!: () => MaybePromise<
    RelayV2HostConnectorControllerCut
  >;
  private readonly startController!: (
    input: Readonly<RelayV2HostConnectorControllerStartInput>,
  ) => MaybePromise<RelayV2HostConnectorControllerStartResult>;
  private readonly stopControllerAndDrain!: (
    input: Readonly<RelayV2HostConnectorControllerStopInput>,
  ) => MaybePromise<RelayV2HostConnectorControllerStopResult>;
  private readonly hostId!: string;
  private readonly hostEpoch!: string;
  private readonly hostInstanceId!: string;
  private readonly credentialReference!: string;
  private readonly signal!: AbortSignal;
  private lastGeneration: bigint | null = null;
  private lastConnectorId: string | null = null;
  private lastStatus: ParsedControllerCut["status"] | null = null;
  private pendingStart: PendingStart | null = null;
  private terminallyClosed = false;

  constructor(options: RelayV2DashboardManagementHostConnectorAdapterOptions) {
    const fields = exactDataObject(options, [
      "controller",
      "hostId",
      "hostEpoch",
      "hostInstanceId",
      "credentialReference",
      "signal",
    ]);
    const inspectCut = dataMethod(fields.controller, "inspectCut");
    const start = dataMethod(fields.controller, "start");
    const stopAndDrain = dataMethod(fields.controller, "stopAndDrain");
    if (!isObject(fields.controller)
      || typeof inspectCut !== "function"
      || typeof start !== "function"
      || typeof stopAndDrain !== "function"
      || !(fields.signal instanceof AbortSignal)) return closed();
    const controller = fields.controller;
    this.inspectControllerCut = () => Reflect.apply(
      inspectCut as RelayV2HostConnectorControllerPort["inspectCut"],
      controller,
      [],
    );
    this.startController = (input) => Reflect.apply(
      start as RelayV2HostConnectorControllerPort["start"],
      controller,
      [input],
    );
    this.stopControllerAndDrain = (input) => Reflect.apply(
      stopAndDrain as RelayV2HostConnectorControllerPort["stopAndDrain"],
      controller,
      [input],
    );
    this.hostId = identifier(fields.hostId);
    this.hostEpoch = identifier(fields.hostEpoch);
    this.hostInstanceId = identifier(fields.hostInstanceId);
    this.credentialReference = credentialReference(fields.credentialReference);
    this.signal = fields.signal;
  }

  async inspectCut(): Promise<RelayV2DashboardManagementConnectorCut> {
    this.ensureOpen();
    try {
      const cut = parseControllerCut(await this.inspectControllerCut());
      this.observe(cut);
      return this.project(cut);
    } catch (error) {
      return this.fail(error);
    }
  }

  start(input: Readonly<{ requestId: string }>): Promise<void> {
    this.ensureOpen();
    let requestedId: string;
    try {
      requestedId = parseRequestId(input);
    } catch (error) {
      return Promise.reject(this.poison(error));
    }
    const pending = this.pendingStart;
    if (pending !== null) {
      if (pending.requestId === requestedId) return pending.promise;
      return Promise.reject(new RelayV2DashboardManagementAuthorityFailure("BUSY"));
    }

    let resolveAttempt!: () => void;
    let rejectAttempt!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt = Object.freeze({ requestId: requestedId, promise });
    this.pendingStart = attempt;

    void (async () => {
      try {
        const result = parseStartResult(await this.startController(Object.freeze({
          requestId: requestedId,
          hostId: this.hostId,
          hostEpoch: this.hostEpoch,
          hostInstanceId: this.hostInstanceId,
          credentialReference: this.credentialReference,
          signal: this.signal,
        })));
        this.validateBinding(result);
        if (result.requestId !== requestedId) return closed();
        this.observeResult(result.controllerGeneration, result.connectorId);
        resolveAttempt();
      } catch (error) {
        rejectAttempt(this.translate(error));
      } finally {
        if (this.pendingStart === attempt) this.pendingStart = null;
      }
    })();
    return promise;
  }

  async stop(input: Readonly<{ requestId: string }>): Promise<void> {
    this.ensureOpen();
    try {
      const requestedId = parseRequestId(input);
      if (this.pendingStart !== null) {
        throw new RelayV2DashboardManagementAuthorityFailure("BUSY");
      }
      const captured = parseControllerCut(await this.inspectControllerCut());
      this.observe(captured);
      if (captured.status === "stopped") return;
      if (captured.status === "superseded") {
        throw new RelayV2DashboardManagementAuthorityFailure("NOT_READY");
      }
      const capturedGeneration = captured.controllerGeneration;
      const capturedConnectorId = captured.connectorId;
      const result = parseStopResult(await this.stopControllerAndDrain(Object.freeze({
        requestId: requestedId,
        controllerGeneration: capturedGeneration,
        connectorId: capturedConnectorId,
        hostId: this.hostId,
        hostEpoch: this.hostEpoch,
        hostInstanceId: this.hostInstanceId,
        credentialReference: this.credentialReference,
        signal: this.signal,
      })));
      this.validateBinding(result);
      if (result.requestId !== requestedId
        || result.controllerGeneration !== capturedGeneration
        || result.connectorId !== capturedConnectorId) return closed();
      if (this.lastGeneration !== BigInt(capturedGeneration)
        || this.lastConnectorId !== capturedConnectorId) {
        throw new RelayV2DashboardManagementAuthorityFailure("NOT_READY");
      }
    } catch (error) {
      return this.fail(error);
    }
  }

  private ensureOpen(): void {
    if (this.terminallyClosed) return closed();
  }

  private validateBinding(binding: RelayV2HostConnectorControllerIdentity): void {
    if (binding.hostId !== this.hostId
      || binding.hostEpoch !== this.hostEpoch
      || binding.hostInstanceId !== this.hostInstanceId
      || binding.credentialReference !== this.credentialReference) return closed();
  }

  private observe(cut: ParsedControllerCut): void {
    const generation = BigInt(cut.controllerGeneration);
    if (cut.status !== "stopped") {
      this.validateBinding(cut as ParsedControllerCut & RelayV2HostConnectorControllerIdentity);
      if (cut.status === "registered" && cut.connectorId === null) return closed();
    }
    if (this.lastGeneration !== null) {
      if (generation < this.lastGeneration) return closed();
      if (generation === this.lastGeneration) {
        if (cut.connectorId !== null
          && this.lastConnectorId !== null
          && cut.connectorId !== this.lastConnectorId) return closed();
        if (this.lastStatus === "stopped" && cut.status !== "stopped") return closed();
      }
    }
    if (this.lastGeneration === null || generation > this.lastGeneration) {
      this.lastGeneration = generation;
      this.lastConnectorId = cut.connectorId;
    } else if (this.lastConnectorId === null && cut.connectorId !== null) {
      this.lastConnectorId = cut.connectorId;
    }
    this.lastStatus = cut.status;
  }

  private observeResult(controllerGeneration: string, connectorId: string): void {
    const generation = BigInt(controllerGeneration);
    if (this.lastGeneration !== null) {
      if (generation < this.lastGeneration) return closed();
      if (generation === this.lastGeneration
        && this.lastStatus !== "starting"
        && this.lastStatus !== "registered") return closed();
      if (generation === this.lastGeneration
        && this.lastConnectorId !== null
        && this.lastConnectorId !== connectorId) return closed();
    }
    this.lastGeneration = generation;
    this.lastConnectorId = connectorId;
    this.lastStatus = "registered";
  }

  private project(cut: ParsedControllerCut): RelayV2DashboardManagementConnectorCut {
    if (cut.status === "stopped" || cut.status === "superseded") {
      return Object.freeze({ status: cut.status });
    }
    if (cut.status === "starting") {
      return Object.freeze({ status: "starting", hostId: this.hostId });
    }
    if (cut.status === "failed") {
      if (cut.retryable === null) return closed();
      return Object.freeze({ status: "failed", retryable: cut.retryable });
    }
    if (cut.acknowledgement !== "host.registered") return closed();
    return Object.freeze({
      status: "registered",
      acknowledgement: "host.registered",
      hostId: this.hostId,
      connectorId: cut.connectorId as string,
      negotiatedCapabilityIntersection: cut.negotiatedCapabilityIntersection,
    });
  }

  private translate(error: unknown): Error {
    if (error instanceof RelayV2DashboardManagementAuthorityFailure) return error;
    if (error instanceof RelayV2DashboardManagementHostConnectorAdapterClosedError) {
      this.terminallyClosed = true;
      return error;
    }
    const mapped = mappedProtocolCode(error);
    if (mapped !== null) return new RelayV2DashboardManagementAuthorityFailure(mapped);
    this.terminallyClosed = true;
    return new RelayV2DashboardManagementHostConnectorAdapterClosedError();
  }

  private poison(error: unknown): Error {
    const translated = this.translate(error);
    if (translated instanceof RelayV2DashboardManagementAuthorityFailure) {
      this.terminallyClosed = true;
      return new RelayV2DashboardManagementHostConnectorAdapterClosedError();
    }
    return translated;
  }

  private fail(error: unknown): never {
    throw this.translate(error);
  }
}
