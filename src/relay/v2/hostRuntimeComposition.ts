import { types as nodeTypes } from "node:util";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  RelayV2HostCarrierActor,
  RelayV2HostCapabilityReadiness,
  releaseRelayV2HostPreCarrierOfferClaim,
} from "./hostCarrier.js";
import type {
  RelayV2HostCarrierConnection,
  RelayV2HostCarrierOptions,
  RelayV2HostCarrierRouteClose,
  RelayV2HostCarrierRouteSink,
  RelayV2HostCarrierStatus,
  RelayV2HostCarrierTransport,
  RelayV2HostLocalUnbindReason,
  RelayV2HostRouteBinding,
  RelayV2HostRouteBindingRejection,
} from "./hostCarrier.js";
import {
  RelayV2HostConnectorCarrierAttemptAdapter,
  RelayV2HostConnectorCarrierAttemptDrainHandle,
} from "./hostConnectorCarrierAttemptAdapter.js";
import type {
  RelayV2HostConnectorCarrierAttemptFactoryInput,
  RelayV2HostConnectorCarrierAttemptFactoryPort,
} from "./hostConnectorCarrierAttemptAdapter.js";
import {
  RelayV2HostConnectorController,
  RelayV2HostConnectorControllerError,
} from "./hostConnectorController.js";
import type {
  RelayV2HostConnectorControllerCut,
  RelayV2HostConnectorControllerPort,
  RelayV2HostConnectorControllerStartResult,
  RelayV2HostConnectorControllerStopResult,
  RelayV2HostConnectorAttemptFactoryPort,
  RelayV2HostConnectorAttemptPort,
  RelayV2HostConnectorAttemptStartInput,
} from "./hostConnectorController.js";
import type {
  RelayV2HostCapabilityReadinessSource,
  RelayV2HostCapabilityReadinessSourceSink,
  RelayV2HostCapabilityReadinessSourceSnapshot,
  RelayV2HostPreCarrierOfferClaim,
  RelayV2HostPreCarrierOfferIssueInput,
} from "./hostCapabilityReadiness.js";
import { createRelayV2HostCodecReadinessActivation } from "./hostCodecReadinessActivation.js";
import type {
  RelayV2HostCodecReadinessLifecycle,
} from "./hostCodecReadinessActivation.js";
import {
  createRelayV2HostRuntimeAuthorityPorts,
  RelayV2HostRuntime,
} from "./hostRuntime.js";
import type {
  RelayV2HostReadinessSnapshot,
  RelayV2HostRuntimeActualAuthorityInput,
  RelayV2HostRuntimeClose,
  RelayV2HostRuntimeOptions,
  RelayV2HostRuntimeOutboundPort,
  RelayV2HostRuntimeWelcomeSerializer,
  RelayV2HostOptionalExtensionAttachment,
  RelayV2RequiredCapability,
} from "./hostRuntime.js";
import { createRelayV2HostH0ReadinessActivation } from "./hostH0ReadinessActivation.js";
import type {
  RelayV2HostH0ReadinessLifecycle,
} from "./hostH0ReadinessActivation.js";
import { createRelayV2HostH1ReadinessActivation } from "./hostH1ReadinessActivation.js";
import type {
  RelayV2HostH1ReadinessLifecycle,
} from "./hostH1ReadinessActivation.js";
import type {
  RelayV2HostH2ReadinessActivation,
  RelayV2HostH2ReadinessLifecycle,
  RelayV2HostH2ReadinessSnapshotSpool,
} from "./hostH2ReadinessActivation.js";
import { createRelayV2HostH3ReadinessActivation } from "./hostH3ReadinessActivation.js";
import type { RelayV2HostH3ReadinessLifecycle } from "./hostH3ReadinessActivation.js";
import type {
  RelayV2HostH2RecoveryCandidate,
} from "./stateSnapshotSpool.js";
import type {
  RelayV2HostCredentialAuthority,
  RelayV2HostCredentialConnectionAdmission,
} from "./hostCredentialAuthority.js";
import {
  isRelayV2HostCredentialAuthority,
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
} from "./hostCredentialAuthority.js";
import {
  prepareRelayV2HostWssTransportLifecycleAttempt,
  RelayV2HostWssTransportLifecycleFactory,
  releaseRelayV2HostWssTransportLifecyclePreparedAttempt,
} from "./hostWssTransportLifecycle.js";
import type {
  RelayV2HostWssTransportLifecycleFactoryOptions,
} from "./hostWssTransportLifecycle.js";
import type { RelayV2HostH0ReadinessPort } from "./hostState.js";
import type {
  RelayV2HostCommandPlaneReadinessCandidate,
} from "./hostCommandPlane.js";
import type { RelayV2HostH3RecoveryCandidate } from "./terminalDurableLineage.js";
import type {
  RelayV2TerminalOpenResponseLineage,
  RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";
/*
 * This import is intentionally the narrow Dashboard authority error/port
 * boundary. The managed Host owner still never imports a Dashboard session,
 * protocol, process, or renderer composition.
 */
import {
  RelayV2DashboardManagementAuthorityFailure,
  type RelayV2DashboardManagementCarrierControlPort,
} from "./relayV2DashboardManagementAuthority.js";
import { isRelayV2AuthIdentifier } from "./token.js";

type ManualReadinessSource = Exclude<
  RelayV2HostCapabilityReadinessSource,
  "codec" | "h0" | "h1" | "h2" | "h3"
>;

const MAX_CARRIER_READINESS_GENERATION = 18_446_744_073_709_551_615n;
const HOST_CARRIER_CREATE_DASHBOARD_MANAGEMENT_CONTROL =
  RelayV2HostCarrierActor.prototype.createDashboardManagementCarrierControlAdapter;
const runtimePreCarrierOfferIssuers = new WeakMap<object, Readonly<{
  issue(input: Readonly<RelayV2HostPreCarrierOfferIssueInput>):
  RelayV2HostPreCarrierOfferClaim | null;
}>>();

declare const relayV2RecoveredHostH2CompositionPairBrand: unique symbol;
declare const relayV2HostDashboardManagementPortBrand: unique symbol;
declare const relayV2HostDashboardManagementBindingBrand: unique symbol;

/** Opaque, owner-bound claim token emitted by one managed Host composition. */
export interface RelayV2HostDashboardManagementPort {
  readonly [relayV2HostDashboardManagementPortBrand]: true;
}

/** Opaque result of the session owner's successful one-shot port claim. */
export interface RelayV2HostDashboardManagementBinding {
  readonly [relayV2HostDashboardManagementBindingBrand]: true;
}

export interface RelayV2HostDashboardManagementIdentity {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly credentialReference: string;
}

export interface RelayV2HostDashboardManagementClosedPorts {
  readonly connectorLifecycle: RelayV2HostConnectorControllerPort;
  readonly carrierControl: RelayV2DashboardManagementCarrierControlPort;
}

type RelayV2HostDashboardManagementPortCapability =
  RelayV2HostDashboardManagementPort & ((
    candidate: unknown,
    expectedIdentity: RelayV2HostDashboardManagementIdentity,
    expectedCredentialOwner: object,
  ) => RelayV2HostDashboardManagementBinding | null);
type RelayV2HostDashboardManagementBindingOperation = "consume" | "commit" | "abort";
type RelayV2HostDashboardManagementBindingOperationResult =
  RelayV2HostDashboardManagementClosedPorts | boolean | null;
type RelayV2HostDashboardManagementBindingCapability =
  RelayV2HostDashboardManagementBinding & ((
    candidate: unknown,
    operation: RelayV2HostDashboardManagementBindingOperation,
    expectedIdentity: RelayV2HostDashboardManagementIdentity,
    expectedCredentialOwner: object,
  ) => RelayV2HostDashboardManagementBindingOperationResult);

/** Opaque issuer half; its receiver identity never leaves this module. */
export interface RelayV2RecoveredHostH2CompositionPair {
  readonly [relayV2RecoveredHostH2CompositionPairBrand]: true;
}

interface RecoveredHostH2CompositionPairRecord {
  readonly receiverIdentity: (
    consumer: (readinessSink: unknown) => Promise<unknown>,
  ) => Promise<unknown> | null;
  readinessSink: RelayV2HostCapabilityReadinessSourceSink<"h2"> | null;
  activationInFlight: boolean;
}

const recoveredHostH2CompositionPairs = new WeakMap<
  object,
  RecoveredHostH2CompositionPairRecord
>();

export function issueRelayV2RecoveredHostH2CompositionPair(
): RelayV2RecoveredHostH2CompositionPair {
  const pair = Object.freeze(Object.create(null)) as RelayV2RecoveredHostH2CompositionPair;
  let record: RecoveredHostH2CompositionPairRecord;
  const receiverIdentity = Object.freeze(async function recoveredHostH2PrivateReceiver(
    this: unknown,
    consumer: (readinessSink: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    if (this !== receiverIdentity
      || typeof consumer !== "function"
      || record.readinessSink === null) return null;
    const readinessSink = record.readinessSink;
    record.readinessSink = null;
    return Reflect.apply(consumer, undefined, [readinessSink]);
  });
  record = {
    receiverIdentity,
    readinessSink: null,
    activationInFlight: false,
  };
  recoveredHostH2CompositionPairs.set(pair as object, record);
  return pair;
}

/** Boolean-only verifier used by the canonical spool activation entry. */
export function matchesRelayV2RecoveredHostH2CompositionReceiver(
  pair: unknown,
  receiverIdentity: unknown,
): boolean {
  if (typeof pair !== "object" || pair === null
    || typeof receiverIdentity !== "function") return false;
  return recoveredHostH2CompositionPairs.get(pair)?.receiverIdentity === receiverIdentity;
}

export type RelayV2HostRuntimeCompositionH2ReadinessLifecycle =
  RelayV2HostH2ReadinessLifecycle;

// Standalone construction is exported for authority-level behavior tests and
// other internal composition roots; this composition never accepts an injected
// activation instance and exposes only its lifecycle.
export { createRelayV2HostH0ReadinessActivation };
export { createRelayV2HostH1ReadinessActivation };

export interface RelayV2HostRuntimeCompositionReadinessLifecycle {
  readonly codec: RelayV2HostCodecReadinessLifecycle;
  readonly carrier: RelayV2HostCapabilityReadinessSourceSink<"carrier">;
  readonly h0: RelayV2HostH0ReadinessLifecycle;
  readonly h1: RelayV2HostH1ReadinessLifecycle;
  readonly h2: RelayV2HostRuntimeCompositionH2ReadinessLifecycle;
  readonly h3: RelayV2HostH3ReadinessLifecycle;
  current(): RelayV2HostReadinessSnapshot;
  advertisedCapabilities(): readonly string[];
}

/** The only host-side routing seam exposed by this default-off composition. */
export interface RelayV2HostRuntimeCompositionRouteSink
  extends RelayV2HostCarrierRouteSink {
  sendTerminalFrame(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
}

export type RelayV2HostRuntimeCompositionSnapshotSpool =
  RelayV2HostH2ReadinessSnapshotSpool;

export type RelayV2HostRuntimeCompositionAuthorities = Omit<
  RelayV2HostRuntimeActualAuthorityInput,
  "h0" | "h1" | "h2" | "snapshotSpool" | "h3"
> & Readonly<{
  h0: RelayV2HostH0ReadinessPort;
  h1RecoveryCandidate: RelayV2HostCommandPlaneReadinessCandidate;
  h2RecoveryCandidate: RelayV2HostH2RecoveryCandidate;
  h3RecoveryCandidate: RelayV2HostH3RecoveryCandidate;
}>;

export interface RelayV2HostRuntimeCompositionOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  authorities: RelayV2HostRuntimeCompositionAuthorities;
  welcome: RelayV2HostRuntimeWelcomeSerializer;
  optionalExtension?: RelayV2HostOptionalExtensionAttachment;
  outbound: RelayV2HostRuntimeOutboundPort;
  /** Tests may only make the existing runtime limits stricter. */
  testLimits?: RelayV2HostRuntimeOptions["testLimits"];
}

export interface RelayV2HostRuntimeComposition {
  readonly routeSink: RelayV2HostRuntimeCompositionRouteSink;
  readonly readiness: RelayV2HostRuntimeCompositionReadinessLifecycle;
  dispose(): Promise<void>;
}

export type RelayV2HostCarrierRuntimeCompositionCarrierOptions = Omit<
  RelayV2HostCarrierOptions,
  | "hostId"
  | "hostEpoch"
  | "hostInstanceId"
  | "routeSink"
  | "credentialConnectionAdmission"
  | "advertisedCapabilities"
  | "preCarrierOfferClaim"
  | "clientDialects"
  | "dialectAdapters"
> & Readonly<{
  hostId?: never;
  hostEpoch?: never;
  hostInstanceId?: never;
  routeSink?: never;
  credentialConnectionAdmission?: never;
  advertisedCapabilities?: never;
  preCarrierOfferClaim?: never;
  clientDialects?: never;
  dialectAdapters?: never;
}>;

export interface RelayV2HostCarrierRuntimeCompositionOptions {
  runtime: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">;
  carrier: RelayV2HostCarrierRuntimeCompositionCarrierOptions;
}

export interface RelayV2HostCarrierRuntimeFacade {
  status(): RelayV2HostCarrierStatus | null;
  connect(
    transport: RelayV2HostCarrierTransport,
    credentialReference: string,
  ): RelayV2HostCarrierConnection;
  requestReauthentication(requestId: string, credentialReference: string): boolean;
}

export interface RelayV2HostCarrierRuntimeCompositionReadinessLifecycle {
  readonly codec: RelayV2HostCodecReadinessLifecycle;
  readonly h0: RelayV2HostH0ReadinessLifecycle;
  readonly h1: RelayV2HostH1ReadinessLifecycle;
  readonly h2: RelayV2HostRuntimeCompositionH2ReadinessLifecycle;
  readonly h3: RelayV2HostH3ReadinessLifecycle;
  current(): RelayV2HostReadinessSnapshot;
}

export interface RelayV2HostCarrierRuntimeComposition {
  readonly carrier: RelayV2HostCarrierRuntimeFacade;
  readonly readiness: RelayV2HostCarrierRuntimeCompositionReadinessLifecycle;
  sendTerminalFrame(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export type RelayV2HostManagedConnectorCarrierOptions = Omit<
  RelayV2HostCarrierRuntimeCompositionCarrierOptions,
  "onStatus"
> & Readonly<{ onStatus?: never }>;

export type RelayV2HostManagedConnectorTransportLifecycleFactoryInput = Omit<
  RelayV2HostConnectorCarrierAttemptFactoryInput,
  "onCarrierStatus" | "carrierAttemptGeneration" | "preCarrierOfferClaim"
>;

export interface RelayV2HostManagedConnectorTransportLifecycle {
  readonly transport: RelayV2HostCarrierTransport;
  readonly bindConnection: (connection: RelayV2HostCarrierConnection) => void;
  readonly awaitDrained: (proof: object) => Promise<object>;
}

export interface RelayV2HostManagedConnectorTransportLifecycleFactoryPort {
  createTransportLifecycle(
    input: Readonly<RelayV2HostManagedConnectorTransportLifecycleFactoryInput>,
  ): RelayV2HostManagedConnectorTransportLifecycle
    | Promise<RelayV2HostManagedConnectorTransportLifecycle>;
}

export interface RelayV2HostManagedConnectorRuntimeCompositionOptions {
  readonly runtime: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">;
  readonly connector: Readonly<{
    credentialReference: string;
    carrier: RelayV2HostManagedConnectorCarrierOptions;
    transportLifecycleFactory: RelayV2HostManagedConnectorTransportLifecycleFactoryPort;
  }>;
}

export type RelayV2HostManagedWssConnectorCarrierOptions = Omit<
  RelayV2HostManagedConnectorCarrierOptions,
  "credentialReferences"
> & Readonly<{ credentialReferences?: never }>;

export type RelayV2HostManagedWssTransportLifecycleOptions = Omit<
  RelayV2HostWssTransportLifecycleFactoryOptions,
  "credentialAuthority"
> & Readonly<{ credentialAuthority?: never }>;

/**
 * Closed input for the default-off managed WSS seam. The credential authority
 * appears exactly once; the composition privately gives that same owner to the
 * carrier metadata path and the WSS Authorization path.
 */
export interface RelayV2HostManagedWssConnectorRuntimeCompositionOptions {
  readonly runtime: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">;
  readonly connector: Readonly<{
    credentialAuthority: RelayV2HostCredentialAuthority;
    credentialReference: string;
    carrier: RelayV2HostManagedWssConnectorCarrierOptions;
    wss: RelayV2HostManagedWssTransportLifecycleOptions;
  }>;
}

export interface RelayV2HostManagedConnectorStartInput {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface RelayV2HostManagedConnectorReauthenticationInput {
  readonly requestId: string;
  readonly controllerGeneration: string;
  readonly connectorId: string;
}

export interface RelayV2HostManagedConnectorStopInput {
  readonly requestId: string;
  readonly controllerGeneration: string;
  readonly connectorId: string | null;
  readonly signal: AbortSignal;
}

export type RelayV2HostManagedConnectorInspection =
  | Readonly<{
      status: "stopped";
      controllerGeneration: string;
    }>
  | Readonly<{
      status: "starting";
      controllerGeneration: string;
      connectorId: null;
    }>
  | Readonly<{
      status: "registered_incomplete";
      controllerGeneration: string;
      connectorId: string;
      acknowledgement: "host.registered";
      negotiatedCapabilityIntersection: readonly [];
    }>
  | Readonly<{
      status: "failed";
      controllerGeneration: string;
      connectorId: string | null;
      retryable: boolean;
    }>
  | Readonly<{
      status: "superseded";
      controllerGeneration: string;
      connectorId: string | null;
    }>;

export interface RelayV2HostManagedConnectorRuntimeComposition {
  readonly dashboardManagementPort: RelayV2HostDashboardManagementPort;
  inspect(): RelayV2HostManagedConnectorInspection;
  start(
    input: Readonly<RelayV2HostManagedConnectorStartInput>,
  ): Promise<RelayV2HostConnectorControllerStartResult>;
  requestReauthentication(
    input: Readonly<RelayV2HostManagedConnectorReauthenticationInput>,
  ): boolean;
  stopAndDrain(
    input: Readonly<RelayV2HostManagedConnectorStopInput>,
  ): Promise<RelayV2HostConnectorControllerStopResult>;
  readonly readiness: RelayV2HostCarrierRuntimeCompositionReadinessLifecycle;
  sendTerminalFrame(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  closeAndDrain(): Promise<void>;
}

function guardedSource<Source extends ManualReadinessSource>(
  sink: RelayV2HostCapabilityReadinessSourceSink<Source>,
  disposed: () => boolean,
): RelayV2HostCapabilityReadinessSourceSink<Source> {
  return Object.freeze({
    apply(snapshot: RelayV2HostCapabilityReadinessSourceSnapshot<Source>): boolean {
      return disposed() ? false : sink.apply(snapshot);
    },
    close(): void {
      if (!disposed()) sink.close();
    },
  });
}

interface RelayV2DeferredBarrier {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function createDeferredBarrier(): RelayV2DeferredBarrier {
  let resolveBarrier: () => void = () => undefined;
  let rejectBarrier: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve;
    rejectBarrier = reject;
  });
  return Object.freeze({
    promise,
    resolve: resolveBarrier,
    reject: rejectBarrier,
  });
}

function captureRuntimeAuthorities(
  value: RelayV2HostRuntimeCompositionAuthorities,
): Readonly<{
  h0: RelayV2HostH0ReadinessPort;
  h1RecoveryCandidate: RelayV2HostCommandPlaneReadinessCandidate;
  h2RecoveryCandidate: RelayV2HostH2RecoveryCandidate;
  h3RecoveryCandidate: RelayV2HostH3RecoveryCandidate;
}> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = [
    "h0",
    "h1RecoveryCandidate",
    "h2RecoveryCandidate",
    "h3RecoveryCandidate",
  ] as const;
  const descriptors: Partial<Record<typeof fields[number], PropertyDescriptor>> = {};
  try {
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
      descriptors[field] = descriptor;
    }
  } catch {
    return null;
  }
  return Object.freeze({
    h0: descriptors.h0!.value as RelayV2HostH0ReadinessPort,
    h1RecoveryCandidate: descriptors.h1RecoveryCandidate!.value as
      RelayV2HostCommandPlaneReadinessCandidate,
    h2RecoveryCandidate: descriptors.h2RecoveryCandidate!.value as
      RelayV2HostH2RecoveryCandidate,
    h3RecoveryCandidate: descriptors.h3RecoveryCandidate!.value as
      RelayV2HostH3RecoveryCandidate,
  });
}

function routeBindingKey(binding: Pick<
  RelayV2HostRouteBinding,
  "connectorGeneration" | "connectorId" | "routeId" | "routeFence"
>): string {
  return JSON.stringify([
    binding.connectorGeneration,
    binding.connectorId,
    binding.routeId,
    binding.routeFence,
  ]);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  try {
    const keys = Object.keys(value);
    return keys.length === expected.length && keys.every((key) => expected.includes(key));
  } catch {
    return false;
  }
}

function sameAuthContext(
  left: RelayV2HostRouteBinding["authContext"],
  right: RelayV2HostRouteBinding["authContext"],
): boolean {
  if (left.scheme !== right.scheme || left.role !== right.role || left.hostId !== right.hostId) {
    return false;
  }
  if (left.scheme === "twcap2" && right.scheme === "twcap2") {
    return hasExactKeys(left, [
      "scheme", "role", "hostId", "principalId", "grantId", "clientInstanceId",
      "jti", "kid", "expiresAtMs",
    ])
      && hasExactKeys(right, [
        "scheme", "role", "hostId", "principalId", "grantId", "clientInstanceId",
        "jti", "kid", "expiresAtMs",
      ])
      && left.principalId === right.principalId
      && left.grantId === right.grantId
      && left.clientInstanceId === right.clientInstanceId
      && left.jti === right.jti
      && left.kid === right.kid
      && left.expiresAtMs === right.expiresAtMs;
  }
  if (left.scheme === "legacy_shared_secret" && right.scheme === "legacy_shared_secret") {
    return hasExactKeys(left, [
      "scheme", "role", "hostId", "principalId", "grantId", "clientInstanceId",
    ])
      && hasExactKeys(right, [
        "scheme", "role", "hostId", "principalId", "grantId", "clientInstanceId",
      ])
      && left.principalId === right.principalId
      && left.grantId === right.grantId
      && left.clientInstanceId === right.clientInstanceId;
  }
  return false;
}

function sameRouteBinding(
  left: RelayV2HostRouteBinding,
  right: RelayV2HostRouteBinding,
): boolean {
  return left.connectorGeneration === right.connectorGeneration
    && left.connectorId === right.connectorId
    && left.routeId === right.routeId
    && left.routeFence === right.routeFence
    && left.connectionId === right.connectionId
    && left.clientDialect === right.clientDialect
    && left.maxFrameBytes === right.maxFrameBytes
    && sameAuthContext(left.authContext, right.authContext);
}

function carrierCloseForRuntime(close: RelayV2HostRuntimeClose): RelayV2HostCarrierRouteClose {
  switch (close.reason) {
    case "slow_consumer":
      if (close.code !== 1013) throw new Error("invalid Relay v2 slow-consumer close code");
      return Object.freeze({
        closeCode: close.code,
        reason: "slow_consumer",
        errorCode: "SLOW_CONSUMER",
        retryable: true,
      });
    case "protocol_error":
    case "event_cursor_ahead":
      if (close.code !== 4400) throw new Error("invalid Relay v2 protocol close code");
      return Object.freeze({
        closeCode: close.code,
        reason: "protocol_error",
        errorCode: "INTERNAL",
        retryable: false,
      });
    case "route_unavailable":
    case "capability_withdrawn":
      if (close.code !== 4406) throw new Error("invalid Relay v2 capability close code");
      return Object.freeze({
        closeCode: close.code,
        reason: "protocol_error",
        errorCode: "CAPABILITY_UNAVAILABLE",
        retryable: false,
      });
    case "authority_failure":
    case "host_shutdown":
      if (close.code !== 1011) throw new Error("invalid Relay v2 host-shutdown close code");
      return Object.freeze({
        closeCode: close.code,
        reason: "host_shutdown",
        errorCode: "INTERNAL",
        retryable: false,
      });
    case "host_superseded":
      if (close.code !== 4409) throw new Error("invalid Relay v2 superseded close code");
      return Object.freeze({
        closeCode: close.code,
        reason: "host_shutdown",
        errorCode: "HOST_SUPERSEDED",
        retryable: false,
      });
  }
}

/**
 * Default-off, unwired host composition foundation.
 *
 * It connects only the existing H0/H1/H2/spool/H3 ports, readiness owner and
 * bounded runtime. It does not construct a carrier, reconnect, advertise to a
 * broker, or infer readiness from an authority object's existence.
 */
export async function completeRelayV2HostRuntimeCompositionFromRecoveredH2(
  pair: unknown,
  candidate: unknown,
  rawOptions: unknown,
): Promise<RelayV2HostRuntimeComposition | null> {
  if (typeof pair !== "object"
    || pair === null
    || typeof candidate !== "object"
    || candidate === null
    || typeof rawOptions !== "object"
    || rawOptions === null) return null;
  const pairRecord = recoveredHostH2CompositionPairs.get(pair);
  if (pairRecord === undefined) return null;
  const canonicalSpoolUrl = new URL("./stateSnapshotSpool.js", import.meta.url).href;
  const canonicalSpool = await import(canonicalSpoolUrl) as typeof import(
    "./stateSnapshotSpool.js"
  );
  if (!canonicalSpool.matchesRelayV2RecoveredHostH2CompositionPair(pair, candidate)) {
    return null;
  }
  const options = rawOptions as RelayV2HostRuntimeCompositionOptions;
  const hostId = options.hostId;
  const hostEpoch = options.hostEpoch;
  const hostInstanceId = options.hostInstanceId;
  const capturedAuthorities = captureRuntimeAuthorities(options.authorities);
  if (capturedAuthorities === null) {
    throw new Error("invalid Relay v2 host composition authority input");
  }
  const readinessOwner = new RelayV2HostCapabilityReadiness();
  const rawSources = Object.freeze({
    codec: readinessOwner.source("codec"),
    carrier: readinessOwner.source("carrier"),
    h0: readinessOwner.source("h0"),
    h1: readinessOwner.source("h1"),
    h2: readinessOwner.source("h2"),
    h3: readinessOwner.source("h3"),
  });
  let h2Activation: RelayV2HostH2ReadinessActivation | null = null;
  let codecActivation: RelayV2HostCodecReadinessLifecycle | null = null;
  let h0Activation: ReturnType<typeof createRelayV2HostH0ReadinessActivation> | null = null;
  let h1Activation: ReturnType<typeof createRelayV2HostH1ReadinessActivation> = null;
  let h3Activation: ReturnType<typeof createRelayV2HostH3ReadinessActivation> | null = null;
  const abandonConstruction = async (): Promise<void> => {
    const barriers: Promise<unknown>[] = [];
    if (options.optionalExtension !== undefined) {
      try { barriers.push(options.optionalExtension.closeAndDrain()); } catch {}
    }
    if (codecActivation !== null) {
      try { codecActivation.close(); } catch {}
    } else {
      try { rawSources.codec.close(); } catch {}
    }
    if (h1Activation !== null) {
      try { barriers.push(h1Activation.close()); } catch {}
    }
    if (h3Activation !== null) {
      try { barriers.push(h3Activation.dispose()); } catch {}
    }
    if (h0Activation !== null) {
      try { h0Activation.dispose(); } catch {}
    }
    if (h2Activation !== null) {
      try { h2Activation.cancelConstruction(); } catch {}
    }
    for (const [source, sink] of Object.entries(rawSources)) {
      if (source === "codec") continue;
      try { sink.close(); } catch {}
    }
    await Promise.allSettled(barriers);
  };
  try {
    codecActivation = createRelayV2HostCodecReadinessActivation({
      readinessSink: rawSources.codec,
    });
    if (codecActivation === null) {
      throw new Error("Relay v2 production codec readiness activation failed");
    }
    h0Activation = createRelayV2HostH0ReadinessActivation({
      hostEpoch,
      hostInstanceId,
      h0Port: capturedAuthorities.h0,
      readinessSink: rawSources.h0,
    });
    h3Activation = createRelayV2HostH3ReadinessActivation({
      hostId,
      hostEpoch,
      hostInstanceId,
      candidate: capturedAuthorities.h3RecoveryCandidate,
      readinessSink: rawSources.h3,
    });
    h1Activation = createRelayV2HostH1ReadinessActivation({
      hostId,
      hostEpoch,
      hostInstanceId,
      candidate: capturedAuthorities.h1RecoveryCandidate,
      readinessSink: rawSources.h1,
    });
    if (h1Activation === null) {
      throw new Error("invalid Relay v2 H1 recovery candidate");
    }
    if (pairRecord.activationInFlight) {
      throw new Error("recovered H2 composition receiver is already active");
    }
    pairRecord.activationInFlight = true;
    pairRecord.readinessSink = rawSources.h2;
    try {
      h2Activation = await canonicalSpool.activateRelayV2RecoveredHostH2CompositionReceiver(
        pairRecord.receiverIdentity,
        capturedAuthorities.h2RecoveryCandidate,
      ) as RelayV2HostH2ReadinessActivation | null;
    } finally {
      pairRecord.readinessSink = null;
      pairRecord.activationInFlight = false;
    }
    if (h2Activation === null) {
      throw new Error("invalid Relay v2 recovered H2 composition receiver");
    }
    recoveredHostH2CompositionPairs.delete(pair);
  } catch (error) {
    await abandonConstruction();
    throw error;
  }
  const runtimeAuthorities: RelayV2HostRuntimeActualAuthorityInput = Object.freeze({
    h0: h0Activation.runtimeH0,
    h1: h1Activation,
    h2: h2Activation.runtimeH2,
    snapshotSpool: h2Activation.snapshotSpool,
    h3: h3Activation.runtimeH3,
  });
  let runtime: RelayV2HostRuntime;
  try {
    const authorityPorts = createRelayV2HostRuntimeAuthorityPorts(runtimeAuthorities);
    runtime = new RelayV2HostRuntime({
      hostId,
      hostEpoch,
      hostInstanceId,
      ...authorityPorts,
      capabilityIntersection: readinessOwner,
      welcome: options.welcome,
      outbound: options.outbound,
      optionalExtension: options.optionalExtension,
      testLimits: options.testLimits,
    });
  } catch (error) {
    await abandonConstruction();
    throw error;
  }
  let disposed = false;
  const isDisposed = () => disposed;

  const readiness: RelayV2HostRuntimeCompositionReadinessLifecycle = Object.freeze({
    codec: codecActivation,
    carrier: guardedSource(rawSources.carrier, isDisposed),
    h0: h0Activation.lifecycle,
    h1: Object.freeze({ close: () => h1Activation.close() }),
    h2: h2Activation.lifecycle,
    h3: h3Activation.lifecycle,
    current: () => readinessOwner.current(),
    advertisedCapabilities: () => runtime.advertisedCapabilities(),
  });

  const routeSink: RelayV2HostRuntimeCompositionRouteSink = Object.freeze({
    onRouteBound(binding: RelayV2HostRouteBinding): void | RelayV2HostRouteBindingRejection {
      return runtime.onRouteBound(binding);
    },
    onClientFrame(binding: RelayV2HostRouteBinding, payload: Uint8Array): void {
      runtime.onClientFrame(binding, payload);
    },
    onRouteClosing(binding: RelayV2HostRouteBinding, _code: string): void {
      runtime.onRouteClosing(binding);
    },
    onRouteUnbound(
      binding: RelayV2HostRouteBinding,
      reason: RelayV2HostLocalUnbindReason,
    ): void {
      runtime.onRouteUnbound(binding, reason);
    },
    sendTerminalFrame(
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ): Promise<void> {
      return runtime.sendTerminalFrame(route, frame, responseLineage);
    },
  });

  let disposeBarrier: Promise<void> | null = null;
  const composition: RelayV2HostRuntimeComposition = Object.freeze({
    routeSink,
    readiness,
    dispose(): Promise<void> {
      if (disposeBarrier !== null) return disposeBarrier;
      const published = createDeferredBarrier();
      disposeBarrier = published.promise;
      disposed = true;
      runtime.fenceOptionalExtensionIngress();
      runtimePreCarrierOfferIssuers.delete(composition);
      const synchronousFailures: unknown[] = [];
      const rememberFailure = (error: unknown): void => {
        if (synchronousFailures.length === 0) synchronousFailures.push(error);
      };
      let h1Barrier: Promise<void> = Promise.resolve();
      let h3Barrier: Promise<void> = Promise.resolve();
      let extensionBarrier: Promise<void> = Promise.resolve();
      try {
        extensionBarrier = options.optionalExtension?.closeAndDrain() ?? Promise.resolve();
      } catch (error) { rememberFailure(error); }
      try { h1Barrier = h1Activation.close(); } catch (error) { rememberFailure(error); }
      try { h3Barrier = h3Activation.dispose(); } catch (error) { rememberFailure(error); }
      try { h0Activation.dispose(); } catch (error) { rememberFailure(error); }
      try { h2Activation.dispose(); } catch (error) { rememberFailure(error); }
      try { codecActivation.close(); } catch (error) { rememberFailure(error); }
      for (const [source, sink] of Object.entries(rawSources)) {
        if (source === "codec"
          || source === "h0"
          || source === "h1"
          || source === "h2"
          || source === "h3") continue;
        try { sink.close(); } catch (error) { rememberFailure(error); }
      }
      try { runtime.dispose(); } catch (error) { rememberFailure(error); }
      void (async () => {
        const asynchronousFailures: unknown[] = [];
        const barriers = await Promise.allSettled([extensionBarrier, h1Barrier, h3Barrier]);
        for (const barrier of barriers) {
          if (barrier.status === "rejected") asynchronousFailures.push(barrier.reason);
        }
        const failures = [...synchronousFailures, ...asynchronousFailures];
        if (failures.length === 0) published.resolve();
        else published.reject(failures[0]);
      })();
      return published.promise;
    },
  });
  runtimePreCarrierOfferIssuers.set(composition, Object.freeze({
    issue: (input: Readonly<RelayV2HostPreCarrierOfferIssueInput>) => (
      readinessOwner.issuePreCarrierOffer(Object.freeze({
        ...input,
        optionalCapabilities: runtime.advertisedOptionalCapabilities(),
      }))
    ),
  }));
  return composition;
}

/**
 * Public construction delegates candidate claim to the canonical spool entry.
 * A successful call returns only the complete, already activated composition.
 */
export async function openRelayV2HostRuntimeComposition(
  options: RelayV2HostRuntimeCompositionOptions,
): Promise<RelayV2HostRuntimeComposition> {
  const canonicalSpoolUrl = new URL("./stateSnapshotSpool.js", import.meta.url).href;
  const canonicalSpool = await import(canonicalSpoolUrl) as typeof import(
    "./stateSnapshotSpool.js"
  );
  const composition = await canonicalSpool.openRelayV2RecoveredHostRuntimeComposition(options);
  if (composition === null) {
    throw new Error("invalid Relay v2 recovered H2 candidate or composition receiver");
  }
  return composition as RelayV2HostRuntimeComposition;
}

interface RelayV2HostCarrierRuntimeBridge {
  readonly routeSink: RelayV2HostCarrierRouteSink;
  readonly readiness: RelayV2HostCarrierRuntimeCompositionReadinessLifecycle;
  attachActor(actor: RelayV2HostCarrierActor): void;
  detachActor(actor: RelayV2HostCarrierActor, withdrawReadiness?: boolean): void;
  observeCarrierStatus(
    actor: RelayV2HostCarrierActor,
    status: Readonly<RelayV2HostCarrierStatus>,
    registeredOfferReady?: boolean,
  ): void;
  issuePreCarrierOffer(
    input: Readonly<RelayV2HostPreCarrierOfferIssueInput>,
  ): RelayV2HostPreCarrierOfferClaim | null;
  withdrawCarrierReadiness(): void;
  fenceNewBindings(): void;
  beginManagedClose(): void;
  sendTerminalFrame(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  disposeRuntime(): Promise<void>;
}

function captureRelayV2HostCarrierRuntimeOptions(
  options: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">,
): Omit<RelayV2HostRuntimeCompositionOptions, "outbound"> {
  return Object.freeze({
    hostId: options.hostId,
    hostEpoch: options.hostEpoch,
    hostInstanceId: options.hostInstanceId,
    authorities: options.authorities,
    welcome: options.welcome,
    optionalExtension: options.optionalExtension,
    testLimits: options.testLimits,
  });
}

async function openRelayV2HostCarrierRuntimeBridge(
  runtimeOptions: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">,
): Promise<RelayV2HostCarrierRuntimeBridge> {
  const bindings = new Map<string, RelayV2HostRouteBinding>();
  let acceptingBindings = true;
  let bridgeActive = true;
  let outboundActive = true;
  let carrierReadinessActive = true;
  let carrierReadinessGeneration = 0n;
  let currentActor: RelayV2HostCarrierActor | null = null;

  const applyCarrierReadiness = (ready: boolean): void => {
    if (!carrierReadinessActive) return;
    if (carrierReadinessGeneration === MAX_CARRIER_READINESS_GENERATION) {
      carrierReadinessActive = false;
      try { runtime.readiness.carrier.close(); } catch {}
      return;
    }
    // Connecting and registered share one connector generation, while the
    // readiness owner requires a newer generation for every readiness flip.
    carrierReadinessGeneration += 1n;
    try {
      runtime.readiness.carrier.apply(Object.freeze({
        source: "carrier",
        generation: carrierReadinessGeneration.toString(10),
        ready,
      }));
    } catch {
      carrierReadinessActive = false;
      try { runtime.readiness.carrier.close(); } catch {}
    }
  };

  const resolveCarrierBinding = (
    binding: RelayV2HostRouteBinding,
  ): RelayV2HostRouteBinding | null => {
    const original = bindings.get(routeBindingKey(binding));
    return original && sameRouteBinding(original, binding) ? original : null;
  };

  const outbound: RelayV2HostRuntimeOutboundPort = Object.freeze({
    trySend(binding, payload, receipt): boolean {
      if (!bridgeActive || !outboundActive || !currentActor) return false;
      const original = resolveCarrierBinding(binding);
      return original ? currentActor.sendPublic(original, payload, receipt) : false;
    },
    close(binding, close): void {
      if (!bridgeActive || !outboundActive || !currentActor) return;
      const original = resolveCarrierBinding(binding);
      if (!original) return;
      currentActor.closeRoute(original, carrierCloseForRuntime(close));
    },
  });

  const runtime = await openRelayV2HostRuntimeComposition({
    hostId: runtimeOptions.hostId,
    hostEpoch: runtimeOptions.hostEpoch,
    hostInstanceId: runtimeOptions.hostInstanceId,
    authorities: runtimeOptions.authorities,
    welcome: runtimeOptions.welcome,
    optionalExtension: runtimeOptions.optionalExtension,
    outbound,
    testLimits: runtimeOptions.testLimits,
  });
  const preCarrierOfferIssuer = runtimePreCarrierOfferIssuers.get(runtime as object);
  if (preCarrierOfferIssuer === undefined) {
    await runtime.dispose().catch(() => undefined);
    throw new RelayV2HostConnectorControllerError("OPERATION_FAILED");
  }

  const routeSink: RelayV2HostCarrierRouteSink = Object.freeze({
    onRouteBound(binding): void | RelayV2HostRouteBindingRejection {
      if (!acceptingBindings || !bridgeActive) {
        return Object.freeze({
          accepted: false,
          code: "CAPABILITY_UNAVAILABLE",
          message: "Relay v2 host carrier/runtime composition is closing",
          retryable: false,
        });
      }
      const key = routeBindingKey(binding);
      if (bindings.has(key)) {
        return Object.freeze({
          accepted: false,
          code: "BUSY",
          message: "Relay v2 host route binding is already composed",
          retryable: true,
        });
      }
      bindings.set(key, binding);
      try {
        const rejection = runtime.routeSink.onRouteBound(binding);
        if (rejection !== undefined) bindings.delete(key);
        return rejection;
      } catch (error) {
        bindings.delete(key);
        throw error;
      }
    },
    onClientFrame(binding, payload): void {
      if (resolveCarrierBinding(binding) !== binding) return;
      runtime.routeSink.onClientFrame(binding, payload);
    },
    onRouteClosing(binding, code): void {
      if (resolveCarrierBinding(binding) !== binding) return;
      runtime.routeSink.onRouteClosing(binding, code);
    },
    onRouteUnbound(binding, reason): void {
      const key = routeBindingKey(binding);
      if (resolveCarrierBinding(binding) !== binding) return;
      bindings.delete(key);
      runtime.routeSink.onRouteUnbound(binding, reason);
    },
  });

  const readiness: RelayV2HostCarrierRuntimeCompositionReadinessLifecycle = Object.freeze({
    codec: runtime.readiness.codec,
    h0: runtime.readiness.h0,
    h1: runtime.readiness.h1,
    h2: runtime.readiness.h2,
    h3: runtime.readiness.h3,
    current: () => runtime.readiness.current(),
  });

  let runtimeDisposeBarrier: Promise<void> | null = null;
  return Object.freeze({
    routeSink,
    readiness,
    attachActor(actor: RelayV2HostCarrierActor): void {
      if (!bridgeActive || currentActor !== null) {
        throw new RelayV2HostConnectorControllerError("OPERATION_FAILED");
      }
      currentActor = actor;
    },
    detachActor(actor: RelayV2HostCarrierActor, withdrawReadiness = false): void {
      if (currentActor !== actor) return;
      if (withdrawReadiness) applyCarrierReadiness(false);
      currentActor = null;
    },
    observeCarrierStatus(
      actor: RelayV2HostCarrierActor,
      status: Readonly<RelayV2HostCarrierStatus>,
      registeredOfferReady = true,
    ): void {
      if (currentActor !== actor) return;
      applyCarrierReadiness(status.phase === "registered" && registeredOfferReady);
    },
    issuePreCarrierOffer(
      input: Readonly<RelayV2HostPreCarrierOfferIssueInput>,
    ): RelayV2HostPreCarrierOfferClaim | null {
      if (!bridgeActive || !acceptingBindings) return null;
      return preCarrierOfferIssuer.issue(input);
    },
    withdrawCarrierReadiness(): void {
      applyCarrierReadiness(false);
    },
    fenceNewBindings(): void {
      acceptingBindings = false;
    },
    beginManagedClose(): void {
      acceptingBindings = false;
      outboundActive = false;
      applyCarrierReadiness(false);
      carrierReadinessActive = false;
      try { runtime.readiness.carrier.close(); } catch {}
    },
    sendTerminalFrame: (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ) => runtime.routeSink.sendTerminalFrame(route, frame, responseLineage),
    disposeRuntime(): Promise<void> {
      if (runtimeDisposeBarrier !== null) return runtimeDisposeBarrier;
      const published = createDeferredBarrier();
      runtimeDisposeBarrier = published.promise;
      acceptingBindings = false;
      let runtimeBarrier: Promise<void> = Promise.resolve();
      let synchronousFailure: unknown = null;
      try { runtimeBarrier = runtime.dispose(); } catch (error) { synchronousFailure = error; }
      bridgeActive = false;
      outboundActive = false;
      carrierReadinessActive = false;
      bindings.clear();
      void (async () => {
        try {
          await runtimeBarrier;
          if (synchronousFailure !== null) throw synchronousFailure;
          published.resolve();
        } catch (error) {
          published.reject(synchronousFailure ?? error);
        }
      })();
      return published.promise;
    },
  });
}

/**
 * Default-off carrier/runtime composition. The public carrier is a frozen
 * transport lifecycle facade; route binding and outbound ownership remain
 * private so callers cannot bypass exact provenance or receipt accounting.
 */
export async function openRelayV2HostCarrierRuntimeComposition(
  options: RelayV2HostCarrierRuntimeCompositionOptions,
): Promise<RelayV2HostCarrierRuntimeComposition> {
  const runtimeOptions = captureRelayV2HostCarrierRuntimeOptions(options.runtime);
  const bridge = await openRelayV2HostCarrierRuntimeBridge(runtimeOptions);
  let actor: RelayV2HostCarrierActor;
  try {
    const {
      onStatus: observedStatus,
      ...carrierOptions
    } = options.carrier;
    actor = new RelayV2HostCarrierActor({
      ...carrierOptions,
      hostId: runtimeOptions.hostId,
      hostEpoch: runtimeOptions.hostEpoch,
      hostInstanceId: runtimeOptions.hostInstanceId,
      routeSink: bridge.routeSink,
      advertisedCapabilities: [],
      preCarrierOfferClaim: undefined,
      clientDialects: ["tw-relay.v2"],
      dialectAdapters: Object.freeze({}),
      onStatus(status): void {
        bridge.observeCarrierStatus(actor, status);
        observedStatus?.(status);
      },
    });
    bridge.attachActor(actor);
  } catch (error) {
    await bridge.disposeRuntime().catch(() => undefined);
    throw error;
  }

  const carrier: RelayV2HostCarrierRuntimeFacade = Object.freeze({
    status: () => actor.status(),
    connect: (transport, credentialReference) => actor.connect(
      transport,
      credentialReference,
    ),
    requestReauthentication: (requestId, credentialReference) => (
      actor.requestReauthentication(requestId, credentialReference)
    ),
  });

  let disposeBarrier: Promise<void> | null = null;
  return Object.freeze({
    carrier,
    readiness: bridge.readiness,
    sendTerminalFrame: (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ) => bridge.sendTerminalFrame(route, frame, responseLineage),
    dispose(): Promise<void> {
      if (disposeBarrier !== null) return disposeBarrier;
      const published = createDeferredBarrier();
      disposeBarrier = published.promise;
      bridge.fenceNewBindings();
      const synchronousFailures: unknown[] = [];
      const rememberFailure = (error: unknown): void => {
        if (synchronousFailures.length === 0) synchronousFailures.push(error);
      };
      let runtimeBarrier: Promise<void> = Promise.resolve();
      try { runtimeBarrier = bridge.disposeRuntime(); } catch (error) { rememberFailure(error); }
      try { actor.dispose(); } catch (error) { rememberFailure(error); }
      bridge.detachActor(actor);
      void (async () => {
        const asynchronousFailures: unknown[] = [];
        try { await runtimeBarrier; } catch (error) { asynchronousFailures.push(error); }
        const failures = [...synchronousFailures, ...asynchronousFailures];
        if (failures.length === 0) published.resolve();
        else published.reject(failures[0]);
      })();
      return published.promise;
    },
  });
}

interface CapturedManagedTransportLifecycleFactory {
  readonly receiver: object;
  readonly createTransportLifecycle:
    RelayV2HostManagedConnectorTransportLifecycleFactoryPort["createTransportLifecycle"];
}

interface CapturedManagedTransportLifecycle {
  readonly receiver: object;
  readonly transport: RelayV2HostCarrierTransport;
  readonly bindConnection: RelayV2HostManagedConnectorTransportLifecycle["bindConnection"];
  readonly awaitDrained: RelayV2HostManagedConnectorTransportLifecycle["awaitDrained"];
}

function managedCompositionFailure(): RelayV2HostConnectorControllerError {
  return new RelayV2HostConnectorControllerError("OPERATION_FAILED");
}

function exactManagedDataObject(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw managedCompositionFailure();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw managedCompositionFailure();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) throw managedCompositionFailure();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function captureManagedMethod(value: unknown, name: string): Function {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) {
    throw managedCompositionFailure();
  }
  let owner: object | null = value;
  while (owner !== null) {
    if (nodeTypes.isProxy(owner)) throw managedCompositionFailure();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
    } catch {
      throw managedCompositionFailure();
    }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        throw managedCompositionFailure();
      }
      return descriptor.value;
    }
    try {
      owner = Object.getPrototypeOf(owner);
    } catch {
      throw managedCompositionFailure();
    }
  }
  throw managedCompositionFailure();
}

function isExactNativePromise(value: unknown): value is Promise<unknown> {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(descriptors, "then")
      && !Object.hasOwn(descriptors, "constructor");
  } catch {
    return false;
  }
}

function captureManagedTransportLifecycleFactory(
  value: unknown,
): CapturedManagedTransportLifecycleFactory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw managedCompositionFailure();
  }
  return Object.freeze({
    receiver: value,
    createTransportLifecycle: captureManagedMethod(
      value,
      "createTransportLifecycle",
    ) as RelayV2HostManagedConnectorTransportLifecycleFactoryPort["createTransportLifecycle"],
  });
}

function captureManagedTransportLifecycle(
  value: unknown,
): CapturedManagedTransportLifecycle {
  const fields = exactManagedDataObject(value, ["transport", "bindConnection", "awaitDrained"]);
  if (typeof fields.transport !== "object" || fields.transport === null
    || Array.isArray(fields.transport)
    || typeof fields.bindConnection !== "function"
    || typeof fields.awaitDrained !== "function") throw managedCompositionFailure();
  // The attempt adapter remains the transport authority. This preflight only
  // ensures our internally constructed actor cannot remain attached if that
  // adapter has to reject before it can bind and later drain the lifecycle.
  captureManagedMethod(fields.transport, "trySend");
  captureManagedMethod(fields.transport, "bufferedAmount");
  captureManagedMethod(fields.transport, "close");
  return Object.freeze({
    receiver: value as object,
    transport: fields.transport as RelayV2HostCarrierTransport,
    bindConnection: fields.bindConnection as
      RelayV2HostManagedConnectorTransportLifecycle["bindConnection"],
    awaitDrained: fields.awaitDrained as
      RelayV2HostManagedConnectorTransportLifecycle["awaitDrained"],
  });
}

function captureManagedWssCarrierOptions(
  value: unknown,
): RelayV2HostManagedWssConnectorCarrierOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw managedCompositionFailure();
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw managedCompositionFailure();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }
  const allowed = new Set([
    "publicPayloadDecoder",
    "maxFrameBytes",
    "terminalMaxFrameBytes",
    "clock",
    "schedule",
    "idFactory",
    "queueLimits",
    "onAuthExpiring",
    "onReauthenticationError",
  ]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], "value"))) {
    throw managedCompositionFailure();
  }
  return Object.freeze(Object.fromEntries(
    (keys as string[]).map((key) => [key, descriptors[key].value]),
  )) as RelayV2HostManagedWssConnectorCarrierOptions;
}

function captureManagedWssOptions(
  value: unknown,
): RelayV2HostManagedWssTransportLifecycleOptions {
  const required = ["relayUrl"] as const;
  const optional = [
    "webSocketConstructor",
    "maxBufferedBytes",
    "closeDrainDeadlineMs",
    "scheduleCloseDrain",
  ] as const;
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw managedCompositionFailure();
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw managedCompositionFailure();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], "value"))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw managedCompositionFailure();
  }
  return Object.freeze(Object.fromEntries(
    (keys as string[]).map((key) => [key, descriptors[key].value]),
  )) as RelayV2HostManagedWssTransportLifecycleOptions;
}

function captureManagedWssRuntimeOptions(
  value: unknown,
): Omit<RelayV2HostRuntimeCompositionOptions, "outbound"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw managedCompositionFailure();
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw managedCompositionFailure();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }
  const required = [
    "hostId", "hostEpoch", "hostInstanceId", "authorities", "welcome",
  ] as const;
  const allowed = new Set<string>([...required, "optionalExtension", "testLimits"]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string"
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], "value"))
    || required.some((key) => !Object.hasOwn(descriptors, key))) {
    throw managedCompositionFailure();
  }
  for (const key of ["hostId", "hostEpoch", "hostInstanceId"] as const) {
    if (!isRelayV2AuthIdentifier(descriptors[key].value)) {
      throw managedCompositionFailure();
    }
  }
  return Object.freeze(Object.fromEntries(
    (keys as string[]).map((key) => [key, descriptors[key].value]),
  )) as Omit<RelayV2HostRuntimeCompositionOptions, "outbound">;
}

function isManagedWssCredentialReference(value: unknown): value is string {
  if (typeof value !== "string"
    || !value.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || Buffer.byteLength(value, "utf8") > 128) return false;
  const identifier = value.slice(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier)
    && !/^(?:twcap2|twref2|twenroll2|twhostboot2)\./.test(identifier);
}

function captureDashboardManagementIdentity(
  value: unknown,
): RelayV2HostDashboardManagementIdentity | null {
  let fields: Record<string, unknown>;
  try {
    fields = exactManagedDataObject(value, [
      "hostId", "hostEpoch", "hostInstanceId", "credentialReference",
    ]);
  } catch {
    return null;
  }
  if (!isRelayV2AuthIdentifier(fields.hostId)
    || !isRelayV2AuthIdentifier(fields.hostEpoch)
    || !isRelayV2AuthIdentifier(fields.hostInstanceId)
    || !isManagedWssCredentialReference(fields.credentialReference)) return null;
  return Object.freeze({
    hostId: fields.hostId,
    hostEpoch: fields.hostEpoch,
    hostInstanceId: fields.hostInstanceId,
    credentialReference: fields.credentialReference,
  });
}

function sameDashboardManagementIdentity(
  left: RelayV2HostDashboardManagementIdentity,
  right: RelayV2HostDashboardManagementIdentity,
): boolean {
  return left.hostId === right.hostId
    && left.hostEpoch === right.hostEpoch
    && left.hostInstanceId === right.hostInstanceId
    && left.credentialReference === right.credentialReference;
}

/**
 * One-shot claim used only by the protocol-v2 session owner. The opaque port
 * carries no reflective owner state; copies, proxies, foreign identities and
 * replays do not reach the managed Host owner.
 */
export function claimRelayV2HostDashboardManagementPort(
  port: unknown,
  expectedIdentity: unknown,
  expectedCredentialOwner: unknown,
): RelayV2HostDashboardManagementBinding | null {
  if (typeof port !== "function" || nodeTypes.isProxy(port)
    || typeof expectedCredentialOwner !== "object" || expectedCredentialOwner === null
    || nodeTypes.isProxy(expectedCredentialOwner)) return null;
  const identity = captureDashboardManagementIdentity(expectedIdentity);
  if (identity === null) return null;
  try {
    return Reflect.apply(
      port as RelayV2HostDashboardManagementPortCapability,
      undefined,
      [port, identity, expectedCredentialOwner],
    );
  } catch {
    return null;
  }
}

function operateRelayV2HostDashboardManagementBinding(
  binding: unknown,
  operation: RelayV2HostDashboardManagementBindingOperation,
  expectedIdentity: unknown,
  expectedCredentialOwner: unknown,
): RelayV2HostDashboardManagementBindingOperationResult {
  if (typeof binding !== "function" || nodeTypes.isProxy(binding)
    || typeof expectedCredentialOwner !== "object" || expectedCredentialOwner === null
    || nodeTypes.isProxy(expectedCredentialOwner)) return null;
  const identity = captureDashboardManagementIdentity(expectedIdentity);
  if (identity === null) return null;
  try {
    return Reflect.apply(
      binding as RelayV2HostDashboardManagementBindingCapability,
      undefined,
      [binding, operation, identity, expectedCredentialOwner],
    );
  } catch {
    return null;
  }
}

/**
 * Transfers a claimed binding once into the Dashboard management composition.
 * The returned ports are closed facades; neither raw owner is observable.
 */
export function consumeRelayV2HostDashboardManagementBinding(
  binding: unknown,
  expectedIdentity: unknown,
  expectedCredentialOwner: unknown,
): RelayV2HostDashboardManagementClosedPorts | null {
  const result = operateRelayV2HostDashboardManagementBinding(
    binding,
    "consume",
    expectedIdentity,
    expectedCredentialOwner,
  );
  return typeof result === "object" && result !== null
    ? result as RelayV2HostDashboardManagementClosedPorts
    : null;
}

export function commitRelayV2HostDashboardManagementBinding(
  binding: unknown,
  expectedIdentity: unknown,
  expectedCredentialOwner: unknown,
): boolean {
  return operateRelayV2HostDashboardManagementBinding(
    binding,
    "commit",
    expectedIdentity,
    expectedCredentialOwner,
  ) === true;
}

export function abortRelayV2HostDashboardManagementBinding(
  binding: unknown,
  expectedIdentity: unknown,
  expectedCredentialOwner: unknown,
): boolean {
  return operateRelayV2HostDashboardManagementBinding(
    binding,
    "abort",
    expectedIdentity,
    expectedCredentialOwner,
  ) === true;
}

function captureManagedStartInput(value: unknown): RelayV2HostManagedConnectorStartInput {
  const fields = exactManagedDataObject(value, ["requestId", "signal"]);
  if (typeof fields.requestId !== "string" || !(fields.signal instanceof AbortSignal)) {
    throw managedCompositionFailure();
  }
  return Object.freeze({
    requestId: fields.requestId,
    signal: fields.signal,
  });
}

function captureManagedReauthenticationInput(
  value: unknown,
): RelayV2HostManagedConnectorReauthenticationInput {
  const fields = exactManagedDataObject(value, [
    "requestId", "controllerGeneration", "connectorId",
  ]);
  if (!isRelayV2AuthIdentifier(fields.requestId)
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(fields.requestId)
    || typeof fields.controllerGeneration !== "string"
    || !/^[1-9][0-9]*$/.test(fields.controllerGeneration)
    || !isRelayV2AuthIdentifier(fields.connectorId)
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(fields.connectorId)) {
    throw managedCompositionFailure();
  }
  try {
    if (BigInt(fields.controllerGeneration) > MAX_CARRIER_READINESS_GENERATION) {
      throw managedCompositionFailure();
    }
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }
  return Object.freeze({
    requestId: fields.requestId,
    controllerGeneration: fields.controllerGeneration,
    connectorId: fields.connectorId,
  });
}

function captureManagedStopInput(value: unknown): RelayV2HostManagedConnectorStopInput {
  const fields = exactManagedDataObject(value, [
    "requestId", "controllerGeneration", "connectorId", "signal",
  ]);
  if (typeof fields.requestId !== "string"
    || typeof fields.controllerGeneration !== "string"
    || (fields.connectorId !== null && typeof fields.connectorId !== "string")
    || !(fields.signal instanceof AbortSignal)) throw managedCompositionFailure();
  return Object.freeze({
    requestId: fields.requestId,
    controllerGeneration: fields.controllerGeneration,
    connectorId: fields.connectorId as string | null,
    signal: fields.signal,
  });
}

function sameManagedStopCut(
  cut: RelayV2HostConnectorControllerCut,
  input: RelayV2HostManagedConnectorStopInput,
): boolean {
  return cut.status !== "stopped"
    && cut.controllerGeneration === input.controllerGeneration
    && cut.connectorId === input.connectorId;
}

function projectManagedConnectorCut(
  cut: RelayV2HostConnectorControllerCut,
): RelayV2HostManagedConnectorInspection {
  switch (cut.status) {
    case "stopped":
      return Object.freeze({
        status: "stopped",
        controllerGeneration: cut.controllerGeneration,
      });
    case "starting":
      return Object.freeze({
        status: "starting",
        controllerGeneration: cut.controllerGeneration,
        connectorId: null,
      });
    case "registered":
      return Object.freeze({
        status: "registered_incomplete",
        controllerGeneration: cut.controllerGeneration,
        connectorId: cut.connectorId,
        acknowledgement: cut.acknowledgement,
        negotiatedCapabilityIntersection: Object.freeze([]),
      });
    case "failed":
      return Object.freeze({
        status: "failed",
        controllerGeneration: cut.controllerGeneration,
        connectorId: cut.connectorId,
        retryable: cut.retryable,
      });
    case "superseded":
      return Object.freeze({
        status: "superseded",
        controllerGeneration: cut.controllerGeneration,
        connectorId: cut.connectorId,
      });
  }
}

/**
 * Default-off closed composition for the canonical controller, its canonical
 * per-attempt HostCarrier actors, and the one host runtime route/readiness
 * owner. The injected seam supplies transport lifecycle only.
 */
export async function openRelayV2HostManagedConnectorRuntimeComposition(
  options: RelayV2HostManagedConnectorRuntimeCompositionOptions,
): Promise<RelayV2HostManagedConnectorRuntimeComposition> {
  const runtimeOptions = captureRelayV2HostCarrierRuntimeOptions(options.runtime);
  const connectorOptions = options.connector;
  const credentialReference = connectorOptions.credentialReference;
  const carrierOptions = connectorOptions.carrier;
  const transportLifecycleFactory = captureManagedTransportLifecycleFactory(
    connectorOptions.transportLifecycleFactory,
  );
  const bridge = await openRelayV2HostCarrierRuntimeBridge(runtimeOptions);
  const attemptRuntimeBindings = new Map<string, Readonly<{
    actor: RelayV2HostCarrierActor | null;
    attach(actor: RelayV2HostCarrierActor, carrierAttemptGeneration: string): void;
    bindCarrierAttemptGeneration(carrierAttemptGeneration: string): void;
    acceptAdapter(): void;
    admitController(connectorId: string): void;
    managementCarrierControl(
      connectorId: string,
    ): RelayV2DashboardManagementCarrierControlPort | null;
    requestReauthentication(requestId: string, connectorId: string): boolean;
    fenceReauthentication(): void;
    observe(status: Readonly<RelayV2HostCarrierStatus>): void;
    reject(): void;
  }>>();

  let controller: RelayV2HostConnectorController;
  let closing = false;
  try {
    const carrierAttemptFactory: RelayV2HostConnectorCarrierAttemptFactoryPort = Object.freeze({
      async createAttempt(
        input: Readonly<RelayV2HostConnectorCarrierAttemptFactoryInput>,
      ): Promise<Readonly<{
        actor: RelayV2HostCarrierActor;
        transport: RelayV2HostCarrierTransport;
        drainHandle: RelayV2HostConnectorCarrierAttemptDrainHandle;
      }>> {
        const runtimeBinding = attemptRuntimeBindings.get(input.controllerGeneration);
        if (runtimeBinding === undefined || runtimeBinding.actor !== null) {
          throw managedCompositionFailure();
        }
        let actor: RelayV2HostCarrierActor | null = null;
        const preCarrierOfferClaim = input.preCarrierOfferClaim ?? null;
        let connectionAdmission: RelayV2HostCredentialConnectionAdmission | null = null;
        try {
          runtimeBinding.bindCarrierAttemptGeneration(input.carrierAttemptGeneration);
          connectionAdmission = prepareRelayV2HostWssTransportLifecycleAttempt(
            transportLifecycleFactory.receiver,
            Object.freeze({
              requestId: input.requestId,
              controllerGeneration: input.controllerGeneration,
              hostId: input.hostId,
              hostEpoch: input.hostEpoch,
              hostInstanceId: input.hostInstanceId,
              credentialReference: input.credentialReference,
              signal: input.signal,
              credentialReferences: carrierOptions.credentialReferences,
            }),
          );
          actor = new RelayV2HostCarrierActor({
            ...carrierOptions,
            hostId: input.hostId,
            hostEpoch: input.hostEpoch,
            hostInstanceId: input.hostInstanceId,
            routeSink: bridge.routeSink,
            credentialConnectionAdmission: connectionAdmission ?? undefined,
            advertisedCapabilities: [],
            preCarrierOfferClaim: preCarrierOfferClaim ?? undefined,
            clientDialects: ["tw-relay.v2"],
            dialectAdapters: Object.freeze({}),
            onStatus: input.onCarrierStatus,
          });
          runtimeBinding.attach(actor, input.carrierAttemptGeneration);
          const lifecycleInput = Object.freeze({
            requestId: input.requestId,
            controllerGeneration: input.controllerGeneration,
            hostId: input.hostId,
            hostEpoch: input.hostEpoch,
            hostInstanceId: input.hostInstanceId,
            credentialReference: input.credentialReference,
            signal: input.signal,
          });
          const pendingLifecycle = Reflect.apply(
            transportLifecycleFactory.createTransportLifecycle,
            transportLifecycleFactory.receiver,
            [lifecycleInput],
          );
          const rawLifecycle = isExactNativePromise(pendingLifecycle)
            ? await pendingLifecycle
            : pendingLifecycle;
          const lifecycle = captureManagedTransportLifecycle(rawLifecycle);
          const drainHandle = new RelayV2HostConnectorCarrierAttemptDrainHandle({
            transport: lifecycle.transport,
            bindConnection(connection): void {
              return Reflect.apply(
                lifecycle.bindConnection,
                lifecycle.receiver,
                [connection],
              ) as void;
            },
            async awaitDrained(proof): Promise<object> {
              runtimeBinding.reject();
              let pendingProof: unknown;
              try {
                pendingProof = Reflect.apply(
                  lifecycle.awaitDrained,
                  lifecycle.receiver,
                  [proof],
                );
              } catch {
                throw managedCompositionFailure();
              }
              if (!isExactNativePromise(pendingProof)) throw managedCompositionFailure();
              try {
                return await pendingProof as object;
              } catch {
                throw managedCompositionFailure();
              }
            },
          });
          return Object.freeze({
            actor,
            transport: lifecycle.transport,
            drainHandle,
          });
        } catch {
          releaseRelayV2HostWssTransportLifecyclePreparedAttempt(
            transportLifecycleFactory.receiver,
            connectionAdmission,
          );
          if (actor === null) releaseRelayV2HostPreCarrierOfferClaim(preCarrierOfferClaim);
          else try { actor.dispose(); } catch {}
          runtimeBinding.reject();
          throw managedCompositionFailure();
        }
      },
    });
    const attemptAdapter = new RelayV2HostConnectorCarrierAttemptAdapter({
      factory: carrierAttemptFactory,
      preCarrierOfferIssuer: Object.freeze({
        issuePreCarrierOffer: (
          input: Readonly<RelayV2HostPreCarrierOfferIssueInput>,
        ) => bridge.issuePreCarrierOffer(input),
      }),
    });
    const attempts: RelayV2HostConnectorAttemptFactoryPort = Object.freeze({
      startAttempt(
        input: Readonly<RelayV2HostConnectorAttemptStartInput>,
      ): Promise<RelayV2HostConnectorAttemptPort> {
        let actor: RelayV2HostCarrierActor | null = null;
        let carrierAttemptGeneration: string | null = null;
        let adapterAccepted = false;
        let controllerAdmitted = false;
        let reauthenticationInFlight = false;
        let reauthenticationFenced = false;
        let rejected = false;
        let latestStatus: Readonly<RelayV2HostCarrierStatus> | null = null;
        const pendingStatuses: Readonly<RelayV2HostCarrierStatus>[] = [];
        const consumedFullOffer = (): boolean => actor !== null
          && carrierAttemptGeneration !== null
          && RelayV2HostCarrierActor.consumedCanonicalPreCarrierOffer(actor, {
            controllerGeneration: input.controllerGeneration,
            carrierAttemptGeneration,
          });
        const forwardStatus = (status: Readonly<RelayV2HostCarrierStatus>): void => {
          if (rejected || actor === null) return;
          latestStatus = status;
          // Preserve the controller's irreversible superseded terminal cut
          // before carrier-readiness withdrawal fences the consumed offer.
          if (status.phase === "superseded") input.onCarrierStatus(status);
          if (controllerAdmitted) {
            bridge.observeCarrierStatus(actor, status, consumedFullOffer());
          }
          if (status.phase !== "superseded") input.onCarrierStatus(status);
        };
        const runtimeBinding = Object.freeze({
          get actor(): RelayV2HostCarrierActor | null { return actor; },
          bindCarrierAttemptGeneration(value: string): void {
            if (carrierAttemptGeneration !== null || rejected) {
              throw managedCompositionFailure();
            }
            carrierAttemptGeneration = value;
          },
          attach(value: RelayV2HostCarrierActor, valueGeneration: string): void {
            if (actor !== null || rejected
              || carrierAttemptGeneration !== valueGeneration) {
              throw managedCompositionFailure();
            }
            actor = value;
            bridge.attachActor(value);
          },
          acceptAdapter(): void {
            if (adapterAccepted || rejected || actor === null) return;
            adapterAccepted = true;
            for (const status of pendingStatuses.splice(0)) forwardStatus(status);
          },
          admitController(connectorId: string): void {
            if (controllerAdmitted || rejected || !adapterAccepted || actor === null) return;
            if (latestStatus?.phase !== "registered"
              || latestStatus.connectorId !== connectorId) return;
            controllerAdmitted = true;
            bridge.observeCarrierStatus(actor, latestStatus, consumedFullOffer());
          },
          managementCarrierControl(
            connectorId: string,
          ): RelayV2DashboardManagementCarrierControlPort | null {
            if (rejected || !controllerAdmitted || actor === null
              || !consumedFullOffer()
              || latestStatus?.phase !== "registered"
              || latestStatus.connectorId !== connectorId
              || attemptRuntimeBindings.get(input.controllerGeneration)
                !== runtimeBinding) return null;
            try {
              return Reflect.apply(
                HOST_CARRIER_CREATE_DASHBOARD_MANAGEMENT_CONTROL,
                actor,
                [],
              );
            } catch {
              return null;
            }
          },
          requestReauthentication(requestId: string, connectorId: string): boolean {
            if (rejected || reauthenticationFenced || reauthenticationInFlight
              || !controllerAdmitted || actor === null) return false;
            const requestActor = actor;
            reauthenticationInFlight = true;
            try {
              return requestActor.requestReauthentication(
                requestId,
                credentialReference,
                (): boolean => {
                  if (closing || rejected || reauthenticationFenced
                    || !controllerAdmitted || actor !== requestActor
                    || attemptRuntimeBindings.get(input.controllerGeneration)
                      !== runtimeBinding) return false;
                  const cut = controller.inspectCut();
                  return cut.status === "registered"
                    && cut.controllerGeneration === input.controllerGeneration
                    && cut.connectorId === connectorId;
                },
              );
            } catch {
              return false;
            } finally {
              reauthenticationInFlight = false;
            }
          },
          fenceReauthentication(): void {
            reauthenticationFenced = true;
          },
          observe(status: Readonly<RelayV2HostCarrierStatus>): void {
            if (rejected || actor === null) return;
            if (!adapterAccepted) {
              pendingStatuses.push(status);
              return;
            }
            forwardStatus(status);
          },
          reject(): void {
            if (rejected) return;
            rejected = true;
            reauthenticationFenced = true;
            pendingStatuses.length = 0;
            if (actor !== null) bridge.detachActor(actor, true);
            if (attemptRuntimeBindings.get(input.controllerGeneration) === runtimeBinding) {
              attemptRuntimeBindings.delete(input.controllerGeneration);
            }
          },
        });
        if (attemptRuntimeBindings.has(input.controllerGeneration)) {
          return Promise.reject(managedCompositionFailure());
        }
        attemptRuntimeBindings.set(input.controllerGeneration, runtimeBinding);
        const attempt = attemptAdapter.startAttempt(Object.freeze({
          ...input,
          onCarrierStatus(status: Readonly<RelayV2HostCarrierStatus>): void {
            runtimeBinding.observe(status);
          },
        }));
        return attempt.then((port) => {
          runtimeBinding.acceptAdapter();
          return port;
        }, (error) => {
          runtimeBinding.reject();
          throw error;
        });
      },
    });
    controller = new RelayV2HostConnectorController({
      attempts,
      hostId: runtimeOptions.hostId,
      hostEpoch: runtimeOptions.hostEpoch,
      hostInstanceId: runtimeOptions.hostInstanceId,
      credentialReference,
    });
  } catch (error) {
    await bridge.disposeRuntime().catch(() => undefined);
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }

  const identity = Object.freeze({
    hostId: runtimeOptions.hostId,
    hostEpoch: runtimeOptions.hostEpoch,
    hostInstanceId: runtimeOptions.hostInstanceId,
    credentialReference,
  });
  let dashboardManagementPort!: RelayV2HostDashboardManagementPortCapability;
  const dashboardManagementIssuedGeneration = controller.inspectCut().controllerGeneration;
  const dashboardManagementAuthority = Object.freeze({});
  let dashboardManagementClaimed = false;
  let dashboardManagementPendingBinding: RelayV2HostDashboardManagementBinding | null = null;
  let dashboardManagementPortFenced = false;
  let closeBarrier: Promise<void> | null = null;

  const hasDashboardManagementAuthority = (authority: unknown): boolean => (
    (!dashboardManagementClaimed && dashboardManagementPendingBinding === null)
      || authority === dashboardManagementAuthority
  );
  const startManagedConnector = (
    rawInput: unknown,
    authority?: unknown,
  ): Promise<RelayV2HostConnectorControllerStartResult> => {
    let input: RelayV2HostManagedConnectorStartInput;
    try {
      input = captureManagedStartInput(rawInput);
    } catch (error) {
      return Promise.reject(error);
    }
    if (closing || !hasDashboardManagementAuthority(authority)) {
      return Promise.reject(new RelayV2HostConnectorControllerError("UNAVAILABLE"));
    }
    return controller.start(Object.freeze({ ...identity, ...input })).then((result) => {
      attemptRuntimeBindings.get(result.controllerGeneration)?.admitController(
        result.connectorId,
      );
      return result;
    });
  };
  const requestManagedReauthentication = (
    rawInput: unknown,
    authority?: unknown,
  ): boolean => {
    let input: RelayV2HostManagedConnectorReauthenticationInput;
    try {
      input = captureManagedReauthenticationInput(rawInput);
    } catch {
      return false;
    }
    try {
      if (closing || !hasDashboardManagementAuthority(authority)) return false;
      const cut = controller.inspectCut();
      if (cut.status !== "registered"
        || cut.controllerGeneration !== input.controllerGeneration
        || cut.connectorId !== input.connectorId) return false;
      const runtimeBinding = attemptRuntimeBindings.get(input.controllerGeneration);
      return runtimeBinding?.requestReauthentication(
        input.requestId,
        input.connectorId,
      ) ?? false;
    } catch {
      return false;
    }
  };
  const stopManagedConnector = (
    rawInput: unknown,
    authority?: unknown,
  ): Promise<RelayV2HostConnectorControllerStopResult> => {
    let input: RelayV2HostManagedConnectorStopInput;
    try {
      input = captureManagedStopInput(rawInput);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!hasDashboardManagementAuthority(authority)) {
      return Promise.reject(new RelayV2HostConnectorControllerError("UNAVAILABLE"));
    }
    const cut = controller.inspectCut();
    if (sameManagedStopCut(cut, input)) {
      attemptRuntimeBindings.get(input.controllerGeneration)?.fenceReauthentication();
      bridge.withdrawCarrierReadiness();
    }
    return controller.stopAndDrain(Object.freeze({ ...identity, ...input }));
  };

  dashboardManagementPort = Object.freeze(function claimDashboardManagementPort(
    candidate: unknown,
    claimedIdentity: RelayV2HostDashboardManagementIdentity,
    claimedCredentialOwner: object,
  ): RelayV2HostDashboardManagementBinding | null {
    const requestedIdentity = captureDashboardManagementIdentity(claimedIdentity);
    if (candidate !== dashboardManagementPort
      || requestedIdentity === null
      || !sameDashboardManagementIdentity(identity, requestedIdentity)
      || claimedCredentialOwner !== carrierOptions.credentialReferences
      || dashboardManagementClaimed
      || dashboardManagementPendingBinding !== null
      || dashboardManagementPortFenced
      || closing) return null;
    let authorizedGeneration: string;
    try {
      authorizedGeneration = controller.inspectCut().controllerGeneration;
    } catch {
      return null;
    }
    if (authorizedGeneration !== dashboardManagementIssuedGeneration) return null;

    let transactionState: "pending" | "committed" | "aborted" = "pending";
    let bindingConsumed = false;
    let bindingFenced = false;
    let binding!: RelayV2HostDashboardManagementBindingCapability;
    const ensureExactGeneration = (): RelayV2HostConnectorControllerCut => {
      if (transactionState !== "committed" || bindingFenced
        || dashboardManagementPortFenced || closing) {
        throw new RelayV2HostConnectorControllerError("UNAVAILABLE");
      }
      const cut = controller.inspectCut();
      if (cut.controllerGeneration !== authorizedGeneration) {
        bindingFenced = true;
        throw managedCompositionFailure();
      }
      return cut;
    };
    const connectorLifecycle: RelayV2HostConnectorControllerPort = Object.freeze({
      inspectCut(): RelayV2HostConnectorControllerCut {
        return ensureExactGeneration();
      },
      start(rawInput): Promise<RelayV2HostConnectorControllerStartResult> {
        let fields: Record<string, unknown>;
        try {
          fields = exactManagedDataObject(rawInput, [
            "requestId", "hostId", "hostEpoch", "hostInstanceId",
            "credentialReference", "signal",
          ]);
        } catch (error) {
          return Promise.reject(error);
        }
        const requestedStartIdentity = captureDashboardManagementIdentity({
          hostId: fields.hostId,
          hostEpoch: fields.hostEpoch,
          hostInstanceId: fields.hostInstanceId,
          credentialReference: fields.credentialReference,
        });
        if (requestedStartIdentity === null
          || !sameDashboardManagementIdentity(identity, requestedStartIdentity)
          || !(fields.signal instanceof AbortSignal)) {
          return Promise.reject(managedCompositionFailure());
        }
        ensureExactGeneration();
        const pending = startManagedConnector(Object.freeze({
          requestId: fields.requestId,
          signal: fields.signal,
        }), dashboardManagementAuthority);
        try {
          authorizedGeneration = controller.inspectCut().controllerGeneration;
        } catch {
          bindingFenced = true;
          return Promise.reject(managedCompositionFailure());
        }
        return pending.then((result) => {
          if (bindingFenced || dashboardManagementPortFenced || closing
            || result.controllerGeneration !== authorizedGeneration) {
            bindingFenced = true;
            throw managedCompositionFailure();
          }
          return result;
        });
      },
      stopAndDrain(rawInput): Promise<RelayV2HostConnectorControllerStopResult> {
        let fields: Record<string, unknown>;
        try {
          fields = exactManagedDataObject(rawInput, [
            "requestId", "controllerGeneration", "connectorId", "hostId",
            "hostEpoch", "hostInstanceId", "credentialReference", "signal",
          ]);
        } catch (error) {
          return Promise.reject(error);
        }
        const requestedStopIdentity = captureDashboardManagementIdentity({
          hostId: fields.hostId,
          hostEpoch: fields.hostEpoch,
          hostInstanceId: fields.hostInstanceId,
          credentialReference: fields.credentialReference,
        });
        if (requestedStopIdentity === null
          || !sameDashboardManagementIdentity(identity, requestedStopIdentity)
          || fields.controllerGeneration !== authorizedGeneration
          || !(fields.signal instanceof AbortSignal)) {
          return Promise.reject(managedCompositionFailure());
        }
        ensureExactGeneration();
        return stopManagedConnector(Object.freeze({
          requestId: fields.requestId,
          controllerGeneration: fields.controllerGeneration,
          connectorId: fields.connectorId,
          signal: fields.signal,
        }), dashboardManagementAuthority).then((result) => {
          if (result.controllerGeneration !== authorizedGeneration) {
            bindingFenced = true;
            throw managedCompositionFailure();
          }
          return result;
        });
      },
    });
    const currentCarrierControl = (): RelayV2DashboardManagementCarrierControlPort => {
      const cut = ensureExactGeneration();
      if (cut.status !== "registered") {
        throw new RelayV2DashboardManagementAuthorityFailure("NOT_READY");
      }
      const control = attemptRuntimeBindings.get(
        authorizedGeneration,
      )?.managementCarrierControl(cut.connectorId);
      if (control === null || control === undefined) {
        throw new RelayV2DashboardManagementAuthorityFailure("NOT_READY");
      }
      return control;
    };
    const carrierControl: RelayV2DashboardManagementCarrierControlPort = Object.freeze({
      createEnrollment: (input) => currentCarrierControl().createEnrollment(input),
      revokeGrant: (input) => currentCarrierControl().revokeGrant(input),
    });
    binding = Object.freeze(function operateDashboardManagementBinding(
      bindingCandidate: unknown,
      operation: RelayV2HostDashboardManagementBindingOperation,
      consumedIdentity: RelayV2HostDashboardManagementIdentity,
      consumedCredentialOwner: object,
    ): RelayV2HostDashboardManagementBindingOperationResult {
      const requestedConsumptionIdentity = captureDashboardManagementIdentity(
        consumedIdentity,
      );
      if (bindingCandidate !== binding
        || requestedConsumptionIdentity === null
        || !sameDashboardManagementIdentity(identity, requestedConsumptionIdentity)
        || consumedCredentialOwner !== carrierOptions.credentialReferences) return null;
      if (operation === "abort") {
        if (transactionState !== "pending") return false;
        transactionState = "aborted";
        let restorable = false;
        try {
          restorable = !dashboardManagementPortFenced
            && !closing
            && controller.inspectCut().controllerGeneration === authorizedGeneration
            && authorizedGeneration === dashboardManagementIssuedGeneration
            && dashboardManagementPendingBinding === binding;
        } catch {}
        if (restorable) dashboardManagementPendingBinding = null;
        return restorable;
      }
      if (operation === "consume") {
        if (transactionState !== "pending" || bindingConsumed
          || dashboardManagementPendingBinding !== binding
          || dashboardManagementPortFenced || closing) return null;
        bindingConsumed = true;
        return Object.freeze({ connectorLifecycle, carrierControl });
      }
      if (operation === "commit") {
        let exactGeneration = false;
        try {
          exactGeneration = controller.inspectCut().controllerGeneration
            === authorizedGeneration;
        } catch {}
        if (transactionState !== "pending" || !bindingConsumed
          || dashboardManagementPendingBinding !== binding
          || dashboardManagementPortFenced || closing || !exactGeneration) return false;
        transactionState = "committed";
        dashboardManagementPendingBinding = null;
        dashboardManagementClaimed = true;
        return true;
      }
      return null;
    }) as RelayV2HostDashboardManagementBindingCapability;
    dashboardManagementPendingBinding = binding;
    return binding;
  }) as RelayV2HostDashboardManagementPortCapability;

  return Object.freeze({
    dashboardManagementPort,
    inspect: () => projectManagedConnectorCut(controller.inspectCut()),
    start: (rawInput) => startManagedConnector(rawInput),
    requestReauthentication: (rawInput) => requestManagedReauthentication(rawInput),
    stopAndDrain: (rawInput) => stopManagedConnector(rawInput),
    readiness: bridge.readiness,
    sendTerminalFrame: (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ) => bridge.sendTerminalFrame(route, frame, responseLineage),
    closeAndDrain(): Promise<void> {
      if (closeBarrier !== null) return closeBarrier;
      const published = createDeferredBarrier();
      closeBarrier = published.promise;
      closing = true;
      dashboardManagementPortFenced = true;
      const closingCut = controller.inspectCut();
      if (closingCut.status !== "stopped") {
        attemptRuntimeBindings.get(
          closingCut.controllerGeneration,
        )?.fenceReauthentication();
      }
      let connectorStop: Promise<RelayV2HostConnectorControllerStopResult> | null = null;
      if (closingCut.status !== "stopped") {
        connectorStop = controller.stopAndDrain(Object.freeze({
          ...identity,
          requestId: `managed-close-${closingCut.controllerGeneration}`,
          controllerGeneration: closingCut.controllerGeneration,
          connectorId: closingCut.connectorId,
          signal: new AbortController().signal,
        }));
      }
      bridge.beginManagedClose();
      void (async () => {
        let firstFailure: unknown = null;
        if (connectorStop !== null) {
          try {
            await connectorStop;
          } catch (error) {
            if (!(error instanceof RelayV2HostConnectorControllerError)
              || error.code !== "SUPERSEDED") firstFailure = error;
          }
        }
        try {
          await bridge.disposeRuntime();
        } catch (error) {
          if (firstFailure === null) firstFailure = error;
        }
        if (firstFailure === null) published.resolve();
        else published.reject(firstFailure);
      })();
      return published.promise;
    },
  });
}

/**
 * Default-off managed Host WSS composition seam.
 *
 * Construction only closes the existing managed composition and WSS factory
 * over one canonical credential authority/reference. It does not open a
 * socket, resolve credential material, start a process/timer/retry, advertise
 * capabilities, or provide a Relay v1 fallback.
 */
export async function openRelayV2HostManagedWssConnectorRuntimeComposition(
  rawOptions: RelayV2HostManagedWssConnectorRuntimeCompositionOptions,
): Promise<RelayV2HostManagedConnectorRuntimeComposition> {
  let fields: Record<string, unknown>;
  let connectorFields: Record<string, unknown>;
  let runtime: Omit<RelayV2HostRuntimeCompositionOptions, "outbound">;
  let carrier: RelayV2HostManagedWssConnectorCarrierOptions;
  let wss: RelayV2HostManagedWssTransportLifecycleOptions;
  try {
    fields = exactManagedDataObject(rawOptions, ["runtime", "connector"]);
    runtime = captureManagedWssRuntimeOptions(fields.runtime);
    connectorFields = exactManagedDataObject(fields.connector, [
      "credentialAuthority",
      "credentialReference",
      "carrier",
      "wss",
    ]);
    if (!isRelayV2HostCredentialAuthority(connectorFields.credentialAuthority)
      || !isManagedWssCredentialReference(connectorFields.credentialReference)) {
      throw managedCompositionFailure();
    }
    carrier = captureManagedWssCarrierOptions(connectorFields.carrier);
    wss = captureManagedWssOptions(connectorFields.wss);
  } catch (error) {
    if (error instanceof RelayV2HostConnectorControllerError) throw error;
    throw managedCompositionFailure();
  }

  const credentialAuthority = connectorFields.credentialAuthority as
    RelayV2HostCredentialAuthority;
  let transportLifecycleFactory: RelayV2HostWssTransportLifecycleFactory;
  try {
    transportLifecycleFactory = new RelayV2HostWssTransportLifecycleFactory({
      ...wss,
      credentialAuthority,
    });
  } catch {
    throw managedCompositionFailure();
  }

  return openRelayV2HostManagedConnectorRuntimeComposition(Object.freeze({
    runtime,
    connector: Object.freeze({
      credentialReference: connectorFields.credentialReference as string,
      carrier: Object.freeze({
        ...carrier,
        credentialReferences: credentialAuthority,
      }),
      transportLifecycleFactory,
    }),
  }));
}
