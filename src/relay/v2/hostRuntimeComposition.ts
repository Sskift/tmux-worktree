import type { RelayV2JsonObject } from "./codecSchema.js";
import { RelayV2HostCarrierActor } from "./hostCarrier.js";
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
  RelayV2HostCapabilityReadiness,
} from "./hostCapabilityReadiness.js";
import type {
  RelayV2HostCapabilityReadinessSource,
  RelayV2HostCapabilityReadinessSourceSink,
  RelayV2HostCapabilityReadinessSourceSnapshot,
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
import type { RelayV2HostH0ReadinessPort } from "./hostState.js";
import type {
  RelayV2HostCommandPlaneReadinessCandidate,
} from "./hostCommandPlane.js";
import type { RelayV2HostH3RecoveryCandidate } from "./terminalDurableLineage.js";
import type {
  RelayV2TerminalOpenResponseLineage,
  RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";

type ManualReadinessSource = Exclude<
  RelayV2HostCapabilityReadinessSource,
  "codec" | "h0" | "h1" | "h2" | "h3"
>;

const MAX_CARRIER_READINESS_GENERATION = 18_446_744_073_709_551_615n;

declare const relayV2RecoveredHostH2CompositionPairBrand: unique symbol;

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
  advertisedCapabilities(): readonly RelayV2RequiredCapability[];
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
  | "advertisedCapabilities"
  | "clientDialects"
  | "dialectAdapters"
> & Readonly<{
  hostId?: never;
  hostEpoch?: never;
  hostInstanceId?: never;
  routeSink?: never;
  advertisedCapabilities?: never;
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
  nextDedupeWindowBounds: RelayV2HostRuntimeActualAuthorityInput["nextDedupeWindowBounds"];
  nextDedupeWindowBoundsReceiver: object;
}> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = [
    "h0",
    "h1RecoveryCandidate",
    "h2RecoveryCandidate",
    "h3RecoveryCandidate",
    "nextDedupeWindowBounds",
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
  const nextDedupeWindowBounds = descriptors.nextDedupeWindowBounds!.value;
  if (typeof nextDedupeWindowBounds !== "function") return null;
  return Object.freeze({
    h0: descriptors.h0!.value as RelayV2HostH0ReadinessPort,
    h1RecoveryCandidate: descriptors.h1RecoveryCandidate!.value as
      RelayV2HostCommandPlaneReadinessCandidate,
    h2RecoveryCandidate: descriptors.h2RecoveryCandidate!.value as
      RelayV2HostH2RecoveryCandidate,
    h3RecoveryCandidate: descriptors.h3RecoveryCandidate!.value as
      RelayV2HostH3RecoveryCandidate,
    nextDedupeWindowBounds,
    nextDedupeWindowBoundsReceiver: value,
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
  const nextDedupeWindowBounds = capturedAuthorities.nextDedupeWindowBounds;
  const nextDedupeWindowBoundsReceiver = capturedAuthorities.nextDedupeWindowBoundsReceiver;
  const runtimeAuthorities: RelayV2HostRuntimeActualAuthorityInput = Object.freeze({
    h0: h0Activation.runtimeH0,
    h1: h1Activation,
    h2: h2Activation.runtimeH2,
    snapshotSpool: h2Activation.snapshotSpool,
    h3: h3Activation.runtimeH3,
    nextDedupeWindowBounds: () => Reflect.apply(
      nextDedupeWindowBounds,
      nextDedupeWindowBoundsReceiver,
      [],
    ),
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
  return Object.freeze({
    routeSink,
    readiness,
    dispose(): Promise<void> {
      if (disposeBarrier !== null) return disposeBarrier;
      const published = createDeferredBarrier();
      disposeBarrier = published.promise;
      disposed = true;
      const synchronousFailures: unknown[] = [];
      const rememberFailure = (error: unknown): void => {
        if (synchronousFailures.length === 0) synchronousFailures.push(error);
      };
      let h1Barrier: Promise<void> = Promise.resolve();
      let h3Barrier: Promise<void> = Promise.resolve();
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
        const barriers = await Promise.allSettled([h1Barrier, h3Barrier]);
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

/**
 * Default-off carrier/runtime composition. The public carrier is a frozen
 * transport lifecycle facade; route binding and outbound ownership remain
 * private so callers cannot bypass exact provenance or receipt accounting.
 */
export async function openRelayV2HostCarrierRuntimeComposition(
  options: RelayV2HostCarrierRuntimeCompositionOptions,
): Promise<RelayV2HostCarrierRuntimeComposition> {
  const runtimeOptions = options.runtime;
  const hostId = runtimeOptions.hostId;
  const hostEpoch = runtimeOptions.hostEpoch;
  const hostInstanceId = runtimeOptions.hostInstanceId;
  const authorities = runtimeOptions.authorities;
  const welcome = runtimeOptions.welcome;
  const testLimits = runtimeOptions.testLimits;
  const bindings = new Map<string, RelayV2HostRouteBinding>();
  let acceptingBindings = true;
  let bridgeActive = true;
  let lifecycleDisposed = false;
  let carrierReadinessActive = true;
  let carrierReadinessGeneration = 0n;
  let actor: RelayV2HostCarrierActor | null = null;

  const applyCarrierStatus = (status: RelayV2HostCarrierStatus): void => {
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
        ready: status.phase === "registered",
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
      if (!bridgeActive || !actor) return false;
      const original = resolveCarrierBinding(binding);
      return original ? actor.sendPublic(original, payload, receipt) : false;
    },
    close(binding, close): void {
      if (!bridgeActive || !actor) return;
      const original = resolveCarrierBinding(binding);
      if (!original) return;
      actor.closeRoute(original, carrierCloseForRuntime(close));
    },
  });

  const runtime = await openRelayV2HostRuntimeComposition({
    hostId,
    hostEpoch,
    hostInstanceId,
    authorities,
    welcome,
    outbound,
    testLimits,
  });

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

  try {
    const {
      onStatus: observedStatus,
      ...carrierOptions
    } = options.carrier;
    actor = new RelayV2HostCarrierActor({
      ...carrierOptions,
      hostId,
      hostEpoch,
      hostInstanceId,
      routeSink,
      advertisedCapabilities: [],
      clientDialects: ["tw-relay.v2"],
      dialectAdapters: Object.freeze({}),
      onStatus(status): void {
        applyCarrierStatus(status);
        observedStatus?.(status);
      },
    });
  } catch (error) {
    carrierReadinessActive = false;
    bridgeActive = false;
    bindings.clear();
    await runtime.dispose().catch(() => undefined);
    throw error;
  }

  const carrier: RelayV2HostCarrierRuntimeFacade = Object.freeze({
    status: () => actor!.status(),
    connect: (transport, credentialReference) => actor!.connect(
      transport,
      credentialReference,
    ),
    requestReauthentication: (requestId, credentialReference) => (
      actor!.requestReauthentication(requestId, credentialReference)
    ),
  });

  const readiness: RelayV2HostCarrierRuntimeCompositionReadinessLifecycle = Object.freeze({
    codec: runtime.readiness.codec,
    h0: runtime.readiness.h0,
    h1: runtime.readiness.h1,
    h2: runtime.readiness.h2,
    h3: runtime.readiness.h3,
    current: () => runtime.readiness.current(),
  });

  let disposeBarrier: Promise<void> | null = null;
  return Object.freeze({
    carrier,
    readiness,
    sendTerminalFrame: (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ) => runtime.routeSink.sendTerminalFrame(route, frame, responseLineage),
    dispose(): Promise<void> {
      if (disposeBarrier !== null) return disposeBarrier;
      const published = createDeferredBarrier();
      disposeBarrier = published.promise;
      lifecycleDisposed = true;
      acceptingBindings = false;
      const synchronousFailures: unknown[] = [];
      const rememberFailure = (error: unknown): void => {
        if (synchronousFailures.length === 0) synchronousFailures.push(error);
      };
      let runtimeBarrier: Promise<void> = Promise.resolve();
      try { runtimeBarrier = runtime.dispose(); } catch (error) { rememberFailure(error); }
      try { actor!.dispose(); } catch (error) { rememberFailure(error); }
      carrierReadinessActive = false;
      bridgeActive = false;
      bindings.clear();
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
