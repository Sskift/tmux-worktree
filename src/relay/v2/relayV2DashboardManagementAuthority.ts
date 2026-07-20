import { Buffer } from "node:buffer";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION,
  RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES,
  createRelayV2DashboardManagementProtocolV2FailureResponse,
  type RelayV2DashboardManagementConnectorProjection,
  type RelayV2DashboardManagementEnrollmentProjection,
  type RelayV2DashboardManagementHostCredentialProjection,
  type RelayV2DashboardManagementKnownClientGrantProjection,
  type RelayV2DashboardManagementProjection,
  type RelayV2DashboardManagementProtocolV2ErrorCode,
  type RelayV2DashboardManagementProtocolV2Handler,
  type RelayV2DashboardManagementProtocolV2Request,
  type RelayV2DashboardManagementProtocolV2Response,
} from "./relayV2DashboardManagementProtocolV2.js";

type MaybePromise<T> = T | Promise<T>;

export type RelayV2DashboardManagementCredentialInspection =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "ready";
      hostId: string;
      credentialReference: string;
      expiresAtMs: number;
    }>
  | Readonly<{ status: "failed"; retryable: boolean }>;

export interface RelayV2DashboardManagementCredentialPort {
  inspect(): MaybePromise<RelayV2DashboardManagementCredentialInspection>;
  bootstrap(input: Readonly<{ requestId: string }>): MaybePromise<void>;
  refresh(input: Readonly<{ requestId: string }>): MaybePromise<void>;
}

export type RelayV2DashboardManagementConnectorInspection =
  | Readonly<{ status: "stopped" }>
  | Readonly<{ status: "starting"; hostId: string | null }>
  | Readonly<{ status: "registered"; hostId: string; connectorId: string }>
  | Readonly<{ status: "failed"; retryable: boolean }>
  | Readonly<{ status: "superseded" }>;

export type RelayV2DashboardManagementReadinessCut =
  | Readonly<{ status: "unavailable" }>
  | Readonly<{
      status: "registered";
      acknowledgement: "host.registered";
      hostId: string;
      connectorId: string;
      negotiatedCapabilityIntersection: readonly string[];
    }>;

export interface RelayV2DashboardManagementConnectorPort {
  inspect(): MaybePromise<RelayV2DashboardManagementConnectorInspection>;
  start(input: Readonly<{ requestId: string }>): MaybePromise<void>;
  stop(input: Readonly<{ requestId: string }>): MaybePromise<void>;
  readinessCut(): MaybePromise<RelayV2DashboardManagementReadinessCut>;
}

export interface RelayV2DashboardManagementEnrollmentReceipt {
  enrollmentId: string;
  enrollmentCode: string;
  expiresAtMs: number;
  issuerUrl: string;
  relayUrl: string;
  hostId: string;
  connectorId: string;
  deviceLabel: string | null;
}

export interface RelayV2DashboardManagementGrantRevocationReceipt {
  grantId: string;
  revokedAtMs: number;
  alreadyRevoked: boolean;
  hostId: string;
  connectorId: string;
}

export interface RelayV2DashboardManagementCarrierControlPort {
  createEnrollment(input: Readonly<{
    requestId: string;
    deviceLabel: string | null;
  }>): MaybePromise<RelayV2DashboardManagementEnrollmentReceipt>;
  revokeGrant(input: Readonly<{
    requestId: string;
    grantId: string;
    reason: "user_revoked";
  }>): MaybePromise<RelayV2DashboardManagementGrantRevocationReceipt>;
}

export interface RelayV2DashboardManagementAuthorityOptions {
  credential: RelayV2DashboardManagementCredentialPort;
  connector: RelayV2DashboardManagementConnectorPort;
  carrierControl: RelayV2DashboardManagementCarrierControlPort;
  clock?: () => number;
}

export class RelayV2DashboardManagementAuthorityFailure extends Error {
  constructor(readonly code: RelayV2DashboardManagementProtocolV2ErrorCode) {
    super("Relay v2 Dashboard management operation failed");
    this.name = "RelayV2DashboardManagementAuthorityFailure";
  }
}

export class RelayV2DashboardManagementAuthorityClosedError extends Error {
  constructor() {
    super("Relay v2 Dashboard management authority closed");
    this.name = "RelayV2DashboardManagementAuthorityClosedError";
  }
}

interface PostOperationCut {
  credential: RelayV2DashboardManagementCredentialInspection;
  connector: RelayV2DashboardManagementConnectorInspection;
  readiness: RelayV2DashboardManagementReadinessCut;
  observedAtMs: number;
}

interface ReadyGate {
  hostId: string;
  connectorId: string;
}

const CREDENTIAL_PREFIXES = Object.freeze([
  "twcap2.",
  "twref2.",
  "twenroll2.",
  "twhostboot2.",
]);

function closed(): never {
  throw new RelayV2DashboardManagementAuthorityClosedError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactDataObject(value: unknown, expected: readonly string[]): Record<string, unknown> {
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
    })) {
    return closed();
  }
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function containsCredential(value: string): boolean {
  const lower = value.toLowerCase();
  return CREDENTIAL_PREFIXES.some((prefix) => lower.includes(prefix));
}

function opaque(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.trim() !== value
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
    || containsCredential(value)) return closed();
  return value;
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return closed();
  return value as number;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") return closed();
  return value;
}

function managementUrl(value: unknown, protocol: "https:" | "wss:", path: string): string {
  if (typeof value !== "string"
    || !/^[\x21-\x7e]+$/.test(value)
    || Buffer.byteLength(value, "utf8") > 2_048
    || containsCredential(value)) return closed();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return closed();
  }
  const prefix = protocol === "https:" ? "https://" : "wss://";
  const authority = value.startsWith(prefix)
    ? value.slice(prefix.length).split("/", 1)[0]
    : "";
  if (parsed.protocol !== protocol
    || parsed.hostname.length === 0
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || authority.endsWith(":")
    || parsed.pathname !== path) return closed();
  return value;
}

function inspectCredential(value: unknown): RelayV2DashboardManagementCredentialInspection {
  if (!isObject(value)) return closed();
  const status = Reflect.get(value, "status");
  if (status === "missing") {
    exactDataObject(value, ["status"]);
    return Object.freeze({ status });
  }
  if (status === "ready") {
    const fields = exactDataObject(value, [
      "status", "hostId", "credentialReference", "expiresAtMs",
    ]);
    return Object.freeze({
      status,
      hostId: opaque(fields.hostId, 128),
      credentialReference: opaque(fields.credentialReference, 256),
      expiresAtMs: timestamp(fields.expiresAtMs),
    });
  }
  if (status === "failed") {
    const fields = exactDataObject(value, ["status", "retryable"]);
    return Object.freeze({ status, retryable: booleanValue(fields.retryable) });
  }
  return closed();
}

function inspectConnector(value: unknown): RelayV2DashboardManagementConnectorInspection {
  if (!isObject(value)) return closed();
  const status = Reflect.get(value, "status");
  if (status === "stopped" || status === "superseded") {
    exactDataObject(value, ["status"]);
    return Object.freeze({ status });
  }
  if (status === "starting") {
    const fields = exactDataObject(value, ["status", "hostId"]);
    return Object.freeze({
      status,
      hostId: fields.hostId === null ? null : opaque(fields.hostId, 128),
    });
  }
  if (status === "registered") {
    const fields = exactDataObject(value, ["status", "hostId", "connectorId"]);
    return Object.freeze({
      status,
      hostId: opaque(fields.hostId, 128),
      connectorId: opaque(fields.connectorId, 128),
    });
  }
  if (status === "failed") {
    const fields = exactDataObject(value, ["status", "retryable"]);
    return Object.freeze({ status, retryable: booleanValue(fields.retryable) });
  }
  return closed();
}

function canonicalCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value)
    || value.length > RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.length) {
    return closed();
  }
  const seen = new Set<string>();
  for (const candidate of value as unknown[]) {
    if (typeof candidate !== "string"
      || !(RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES as readonly string[])
        .includes(candidate)
      || seen.has(candidate)) return closed();
    seen.add(candidate);
  }
  return Object.freeze(RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.filter(
    (capability) => seen.has(capability),
  ));
}

function inspectReadiness(value: unknown): RelayV2DashboardManagementReadinessCut {
  if (!isObject(value)) return closed();
  const status = Reflect.get(value, "status");
  if (status === "unavailable") {
    exactDataObject(value, ["status"]);
    return Object.freeze({ status });
  }
  if (status !== "registered") return closed();
  const fields = exactDataObject(value, [
    "status",
    "acknowledgement",
    "hostId",
    "connectorId",
    "negotiatedCapabilityIntersection",
  ]);
  if (fields.acknowledgement !== "host.registered") return closed();
  return Object.freeze({
    status,
    acknowledgement: "host.registered",
    hostId: opaque(fields.hostId, 128),
    connectorId: opaque(fields.connectorId, 128),
    negotiatedCapabilityIntersection: canonicalCapabilities(
      fields.negotiatedCapabilityIntersection,
    ),
  });
}

function enrollmentReceipt(
  value: unknown,
  expectedDeviceLabel: string | null,
): RelayV2DashboardManagementEnrollmentReceipt {
  const fields = exactDataObject(value, [
    "enrollmentId",
    "enrollmentCode",
    "expiresAtMs",
    "issuerUrl",
    "relayUrl",
    "hostId",
    "connectorId",
    "deviceLabel",
  ]);
  if (typeof fields.enrollmentCode !== "string"
    || !fields.enrollmentCode.startsWith("twenroll2.")
    || fields.enrollmentCode.length === "twenroll2.".length
    || Buffer.byteLength(fields.enrollmentCode, "utf8") > 512
    || fields.enrollmentCode.trim() !== fields.enrollmentCode
    || fields.enrollmentCode.includes("\0")
    || fields.enrollmentCode.includes("\r")
    || fields.enrollmentCode.includes("\n")) return closed();
  const deviceLabel = fields.deviceLabel === null ? null : opaque(fields.deviceLabel, 128);
  if (deviceLabel !== expectedDeviceLabel) return closed();
  return Object.freeze({
    enrollmentId: opaque(fields.enrollmentId, 128),
    enrollmentCode: fields.enrollmentCode,
    expiresAtMs: timestamp(fields.expiresAtMs),
    issuerUrl: managementUrl(fields.issuerUrl, "https:", "/"),
    relayUrl: managementUrl(fields.relayUrl, "wss:", "/client"),
    hostId: opaque(fields.hostId, 128),
    connectorId: opaque(fields.connectorId, 128),
    deviceLabel,
  });
}

function revocationReceipt(
  value: unknown,
  expectedGrantId: string,
): RelayV2DashboardManagementGrantRevocationReceipt {
  const fields = exactDataObject(value, [
    "grantId", "revokedAtMs", "alreadyRevoked", "hostId", "connectorId",
  ]);
  const grantId = opaque(fields.grantId, 128);
  if (grantId !== expectedGrantId) return closed();
  return Object.freeze({
    grantId,
    revokedAtMs: timestamp(fields.revokedAtMs),
    alreadyRevoked: booleanValue(fields.alreadyRevoked),
    hostId: opaque(fields.hostId, 128),
    connectorId: opaque(fields.connectorId, 128),
  });
}

function completeCapabilities(readiness: RelayV2DashboardManagementReadinessCut): boolean {
  return readiness.status === "registered"
    && readiness.negotiatedCapabilityIntersection.length
      === RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.length;
}

function exactRegisteredBinding(cut: PostOperationCut): boolean {
  const { connector, readiness } = cut;
  return connector.status === "registered"
    && readiness.status === "registered"
    && connector.hostId === readiness.hostId
    && connector.connectorId === readiness.connectorId;
}

function validateCutConsistency(cut: PostOperationCut): void {
  if (cut.connector.status === "registered") {
    if (!exactRegisteredBinding(cut)) return closed();
  } else if (cut.readiness.status !== "unavailable") {
    return closed();
  }
}

function activeGate(cut: PostOperationCut): ReadyGate | null {
  const { connector, readiness, credential } = cut;
  if (connector.status !== "registered"
    || readiness.status !== "registered"
    || connector.hostId !== readiness.hostId
    || connector.connectorId !== readiness.connectorId
    || !completeCapabilities(readiness)
    || credential.status !== "ready"
    || credential.hostId !== connector.hostId) return null;
  return Object.freeze({
    hostId: connector.hostId,
    connectorId: connector.connectorId,
  });
}

function registeredCarrierGate(cut: PostOperationCut): ReadyGate | null {
  const { connector, readiness, credential } = cut;
  if (connector.status !== "registered"
    || readiness.status !== "registered"
    || connector.hostId !== readiness.hostId
    || connector.connectorId !== readiness.connectorId
    || credential.status !== "ready"
    || credential.hostId !== connector.hostId) return null;
  return Object.freeze({
    hostId: connector.hostId,
    connectorId: connector.connectorId,
  });
}

/**
 * Unwired process-local projection/orchestration owner. It receives only
 * narrow authority ports, never storage, transport configuration, credential
 * material, a broker authority, or a fallback protocol.
 */
export class RelayV2DashboardManagementAuthority
implements RelayV2DashboardManagementProtocolV2Handler {
  private readonly credential: RelayV2DashboardManagementCredentialPort;
  private readonly connector: RelayV2DashboardManagementConnectorPort;
  private readonly carrierControl: RelayV2DashboardManagementCarrierControlPort;
  private readonly clock: () => number;
  private currentEnrollment: RelayV2DashboardManagementEnrollmentReceipt | null = null;
  private knownClientGrant: RelayV2DashboardManagementKnownClientGrantProjection =
    Object.freeze({ status: "unknown" });
  private serial: Promise<void> = Promise.resolve();
  private terminallyClosed = false;

  constructor(options: RelayV2DashboardManagementAuthorityOptions) {
    if (!isObject(options)
      || !isObject(options.credential)
      || typeof options.credential.inspect !== "function"
      || typeof options.credential.bootstrap !== "function"
      || typeof options.credential.refresh !== "function"
      || !isObject(options.connector)
      || typeof options.connector.inspect !== "function"
      || typeof options.connector.start !== "function"
      || typeof options.connector.stop !== "function"
      || typeof options.connector.readinessCut !== "function"
      || !isObject(options.carrierControl)
      || typeof options.carrierControl.createEnrollment !== "function"
      || typeof options.carrierControl.revokeGrant !== "function"
      || (options.clock !== undefined && typeof options.clock !== "function")) {
      return closed();
    }
    this.credential = options.credential;
    this.connector = options.connector;
    this.carrierControl = options.carrierControl;
    this.clock = options.clock ?? Date.now;
  }

  handle(
    request: RelayV2DashboardManagementProtocolV2Request,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> {
    const operation = this.serial.then(() => this.execute(request));
    this.serial = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async execute(
    request: RelayV2DashboardManagementProtocolV2Request,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> {
    if (this.terminallyClosed) return closed();
    try {
      return await this.executeOpen(request);
    } catch (error) {
      if (error instanceof RelayV2DashboardManagementAuthorityFailure) {
        try {
          this.currentEnrollment = null;
          return createRelayV2DashboardManagementProtocolV2FailureResponse(
            request.requestId,
            error.code,
          );
        } catch {}
      }
      this.terminallyClosed = true;
      this.currentEnrollment = null;
      return closed();
    }
  }

  private async executeOpen(
    request: RelayV2DashboardManagementProtocolV2Request,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> {
    if (request.protocolVersion !== RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION) {
      return closed();
    }
    switch (request.operation) {
      case "status":
        return this.success(request.requestId, await this.readPostOperationCut(), "status");
      case "bootstrap_host":
        await this.voidMutation(this.credential.bootstrap({ requestId: request.requestId }));
        return this.success(
          request.requestId,
          await this.readPostOperationCut(),
          "bootstrap_host",
        );
      case "refresh_host":
        await this.voidMutation(this.credential.refresh({ requestId: request.requestId }));
        return this.success(
          request.requestId,
          await this.readPostOperationCut(),
          "refresh_host",
        );
      case "start_connector":
        await this.voidMutation(this.connector.start({ requestId: request.requestId }));
        return this.success(
          request.requestId,
          await this.readPostOperationCut(),
          "start_connector",
        );
      case "stop_connector":
        await this.voidMutation(this.connector.stop({ requestId: request.requestId }));
        this.currentEnrollment = null;
        return this.success(
          request.requestId,
          await this.readPostOperationCut(),
          "stop_connector",
        );
      case "create_enrollment":
        return this.createEnrollment(request);
      case "revoke_client_grant":
        return this.revokeGrant(request);
    }
    return closed();
  }

  private async createEnrollment(
    request: Extract<RelayV2DashboardManagementProtocolV2Request, {
      operation: "create_enrollment";
    }>,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> {
    const gate = activeGate(await this.readPostOperationCut());
    if (!gate) {
      this.currentEnrollment = null;
      return createRelayV2DashboardManagementProtocolV2FailureResponse(
        request.requestId,
        "NOT_READY",
      );
    }
    const receipt = enrollmentReceipt(await this.carrierControl.createEnrollment({
      requestId: request.requestId,
      deviceLabel: request.input.deviceLabel,
    }), request.input.deviceLabel);
    const observedAtMs = this.now();
    if (receipt.hostId !== gate.hostId
      || receipt.connectorId !== gate.connectorId
      || receipt.expiresAtMs <= observedAtMs) return closed();
    this.currentEnrollment = receipt;
    const postOperationCut = await this.readPostOperationCut();
    const postOperationGate = activeGate(postOperationCut);
    if (!postOperationGate
      || postOperationGate.hostId !== gate.hostId
      || postOperationGate.connectorId !== gate.connectorId) {
      this.currentEnrollment = null;
      return createRelayV2DashboardManagementProtocolV2FailureResponse(
        request.requestId,
        "NOT_READY",
      );
    }
    return this.success(request.requestId, postOperationCut, "create_enrollment");
  }

  private async revokeGrant(
    request: Extract<RelayV2DashboardManagementProtocolV2Request, {
      operation: "revoke_client_grant";
    }>,
  ): Promise<RelayV2DashboardManagementProtocolV2Response> {
    const gate = registeredCarrierGate(await this.readPostOperationCut());
    if (!gate) {
      return createRelayV2DashboardManagementProtocolV2FailureResponse(
        request.requestId,
        "NOT_READY",
      );
    }
    const receipt = revocationReceipt(await this.carrierControl.revokeGrant({
      requestId: request.requestId,
      grantId: request.input.grantId,
      reason: "user_revoked",
    }), request.input.grantId);
    if (receipt.hostId !== gate.hostId || receipt.connectorId !== gate.connectorId) {
      return closed();
    }
    this.knownClientGrant = Object.freeze({
      status: "revoked",
      grantId: receipt.grantId,
      revokedAtMs: receipt.revokedAtMs,
      alreadyRevoked: receipt.alreadyRevoked,
    });
    return this.success(
      request.requestId,
      await this.readPostOperationCut(),
      "revoke_client_grant",
    );
  }

  private async readPostOperationCut(): Promise<PostOperationCut> {
    const credential = inspectCredential(await this.credential.inspect());
    const connector = inspectConnector(await this.connector.inspect());
    const readiness = inspectReadiness(await this.connector.readinessCut());
    const cut = Object.freeze({
      credential,
      connector,
      readiness,
      observedAtMs: this.now(),
    });
    validateCutConsistency(cut);
    return cut;
  }

  private now(): number {
    return timestamp(this.clock());
  }

  private async voidMutation(result: MaybePromise<void>): Promise<void> {
    const settled = await result;
    if (settled !== undefined) return closed();
  }

  private success(
    requestId: string,
    cut: PostOperationCut,
    operation: RelayV2DashboardManagementProtocolV2Request["operation"],
  ): RelayV2DashboardManagementProtocolV2Response {
    const result = this.project(cut);
    if (operation === "create_enrollment" && result.enrollment.status !== "active") {
      return closed();
    }
    if (operation === "revoke_client_grant"
      && result.knownClientGrant.status !== "revoked") return closed();
    return Object.freeze({
      protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION,
      requestId,
      ok: true,
      result,
      error: null,
    });
  }

  private project(cut: PostOperationCut): RelayV2DashboardManagementProjection {
    if (cut.connector.status === "registered"
      && completeCapabilities(cut.readiness)
      && cut.credential.status !== "ready") return closed();
    const gate = activeGate(cut);
    let enrollment: RelayV2DashboardManagementEnrollmentProjection =
      Object.freeze({ status: "idle" });
    const current = this.currentEnrollment;
    if (current) {
      if (current.expiresAtMs <= cut.observedAtMs) {
        this.currentEnrollment = null;
        enrollment = Object.freeze({
          status: "expired",
          enrollmentId: current.enrollmentId,
          expiredAtMs: current.expiresAtMs,
        });
      } else if (!gate
        || gate.hostId !== current.hostId
        || gate.connectorId !== current.connectorId) {
        this.currentEnrollment = null;
      } else {
        enrollment = Object.freeze({
          status: "active",
          review: Object.freeze({
            enrollment: Object.freeze({
              enrollmentId: current.enrollmentId,
              enrollmentCode: current.enrollmentCode,
              expiresAtMs: current.expiresAtMs,
            }),
            display: Object.freeze({
              issuerUrl: current.issuerUrl,
              relayUrl: current.relayUrl,
              hostId: current.hostId,
              deviceLabel: current.deviceLabel,
            }),
          }),
        });
      }
    }
    return Object.freeze({
      authority: Object.freeze({ kind: "node", reason: null }),
      hostCredential: this.projectCredential(cut.credential),
      connector: this.projectConnector(cut),
      enrollment,
      knownClientGrant: this.knownClientGrant,
    });
  }

  private projectCredential(
    credential: RelayV2DashboardManagementCredentialInspection,
  ): RelayV2DashboardManagementHostCredentialProjection {
    if (credential.status === "missing") return Object.freeze({ status: "missing" });
    if (credential.status === "failed") {
      return Object.freeze({ status: "failed", retryable: credential.retryable });
    }
    return Object.freeze({
      status: "ready",
      credentialReference: credential.credentialReference,
      expiresAtMs: credential.expiresAtMs,
    });
  }

  private projectConnector(cut: PostOperationCut): RelayV2DashboardManagementConnectorProjection {
    const connector = cut.connector;
    if (connector.status === "stopped" || connector.status === "superseded") {
      return Object.freeze({ status: connector.status });
    }
    if (connector.status === "starting") {
      return Object.freeze({ status: "starting", hostId: connector.hostId });
    }
    if (connector.status === "failed") {
      return Object.freeze({ status: "failed", retryable: connector.retryable });
    }
    if (cut.readiness.status !== "registered") return closed();
    const complete = completeCapabilities(cut.readiness);
    return Object.freeze({
      status: complete ? "registered" : "registered_incomplete",
      acknowledgement: "host.registered",
      hostId: connector.hostId,
      connectorId: connector.connectorId,
      negotiatedCapabilityIntersection: cut.readiness.negotiatedCapabilityIntersection,
    });
  }
}
