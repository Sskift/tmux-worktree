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
import { createRelayV2HostH2ReadinessActivation } from "./hostH2ReadinessActivation.js";
import type {
  RelayV2HostH2ReadinessLifecycle,
  RelayV2HostH2ReadinessSnapshotSpool,
} from "./hostH2ReadinessActivation.js";
import type {
  RelayV2StateSnapshotHostH2Authority,
} from "./stateSnapshotSpool.js";
import type {
  RelayV2TerminalOpenResponseLineage,
  RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";

type NonH2ReadinessSource = Exclude<RelayV2HostCapabilityReadinessSource, "h2">;

export type RelayV2HostRuntimeCompositionH2ReadinessLifecycle =
  RelayV2HostH2ReadinessLifecycle;

export interface RelayV2HostRuntimeCompositionReadinessLifecycle {
  readonly codec: RelayV2HostCapabilityReadinessSourceSink<"codec">;
  readonly carrier: RelayV2HostCapabilityReadinessSourceSink<"carrier">;
  readonly h0: RelayV2HostCapabilityReadinessSourceSink<"h0">;
  readonly h1: RelayV2HostCapabilityReadinessSourceSink<"h1">;
  readonly h2: RelayV2HostRuntimeCompositionH2ReadinessLifecycle;
  readonly h3: RelayV2HostCapabilityReadinessSourceSink<"h3">;
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
  "h2" | "snapshotSpool"
> & Readonly<{
  h2SnapshotAuthority: RelayV2StateSnapshotHostH2Authority;
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
  dispose(): void;
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

export interface RelayV2HostCarrierRuntimeComposition {
  readonly carrier: RelayV2HostCarrierRuntimeFacade;
  readonly readiness: RelayV2HostRuntimeCompositionReadinessLifecycle;
  sendTerminalFrame(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    responseLineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  dispose(): void;
}

function guardedSource<Source extends NonH2ReadinessSource>(
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

function captureRuntimeAuthorities(
  value: RelayV2HostRuntimeCompositionAuthorities,
): Readonly<{
  h0: RelayV2HostRuntimeActualAuthorityInput["h0"];
  h1: RelayV2HostRuntimeActualAuthorityInput["h1"];
  h2SnapshotAuthority: RelayV2StateSnapshotHostH2Authority;
  h3: RelayV2HostRuntimeActualAuthorityInput["h3"];
  nextDedupeWindowBounds: RelayV2HostRuntimeActualAuthorityInput["nextDedupeWindowBounds"];
  nextDedupeWindowBoundsReceiver: object;
}> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = ["h0", "h1", "h2SnapshotAuthority", "h3", "nextDedupeWindowBounds"] as const;
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
    h0: descriptors.h0!.value as RelayV2HostRuntimeActualAuthorityInput["h0"],
    h1: descriptors.h1!.value as RelayV2HostRuntimeActualAuthorityInput["h1"],
    h2SnapshotAuthority: descriptors.h2SnapshotAuthority!.value as
      RelayV2StateSnapshotHostH2Authority,
    h3: descriptors.h3!.value as RelayV2HostRuntimeActualAuthorityInput["h3"],
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
export function createRelayV2HostRuntimeComposition(
  options: RelayV2HostRuntimeCompositionOptions,
): RelayV2HostRuntimeComposition {
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
  const h2Activation = createRelayV2HostH2ReadinessActivation({
    hostId,
    hostEpoch,
    hostInstanceId,
    authority: capturedAuthorities.h2SnapshotAuthority,
    readinessSink: rawSources.h2,
  });
  const nextDedupeWindowBounds = capturedAuthorities.nextDedupeWindowBounds;
  const nextDedupeWindowBoundsReceiver = capturedAuthorities.nextDedupeWindowBoundsReceiver;
  const runtimeAuthorities: RelayV2HostRuntimeActualAuthorityInput = Object.freeze({
    h0: capturedAuthorities.h0,
    h1: capturedAuthorities.h1,
    h2: h2Activation.runtimeH2,
    snapshotSpool: h2Activation.snapshotSpool,
    h3: capturedAuthorities.h3,
    nextDedupeWindowBounds: () => Reflect.apply(
      nextDedupeWindowBounds,
      nextDedupeWindowBoundsReceiver,
      [],
    ),
  });
  const authorityPorts = createRelayV2HostRuntimeAuthorityPorts(runtimeAuthorities);
  const runtime = new RelayV2HostRuntime({
    hostId,
    hostEpoch,
    hostInstanceId,
    ...authorityPorts,
    capabilityIntersection: readinessOwner,
    welcome: options.welcome,
    outbound: options.outbound,
    testLimits: options.testLimits,
  });
  let disposed = false;
  const isDisposed = () => disposed;

  const readiness: RelayV2HostRuntimeCompositionReadinessLifecycle = Object.freeze({
    codec: guardedSource(rawSources.codec, isDisposed),
    carrier: guardedSource(rawSources.carrier, isDisposed),
    h0: guardedSource(rawSources.h0, isDisposed),
    h1: guardedSource(rawSources.h1, isDisposed),
    h2: h2Activation.lifecycle,
    h3: guardedSource(rawSources.h3, isDisposed),
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

  return Object.freeze({
    routeSink,
    readiness,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      h2Activation.dispose();
      for (const [source, sink] of Object.entries(rawSources)) {
        if (source !== "h2") sink.close();
      }
      runtime.dispose();
    },
  });
}

/**
 * Default-off carrier/runtime composition. The public carrier is a frozen
 * transport lifecycle facade; route binding and outbound ownership remain
 * private so callers cannot bypass exact provenance or receipt accounting.
 */
export function createRelayV2HostCarrierRuntimeComposition(
  options: RelayV2HostCarrierRuntimeCompositionOptions,
): RelayV2HostCarrierRuntimeComposition {
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
  let actor: RelayV2HostCarrierActor | null = null;

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

  const runtime = createRelayV2HostRuntimeComposition({
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
    actor = new RelayV2HostCarrierActor({
      ...options.carrier,
      hostId,
      hostEpoch,
      hostInstanceId,
      routeSink,
      advertisedCapabilities: [],
      clientDialects: ["tw-relay.v2"],
      dialectAdapters: Object.freeze({}),
    });
  } catch (error) {
    bridgeActive = false;
    bindings.clear();
    try { runtime.dispose(); } catch {}
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

  return Object.freeze({
    carrier,
    readiness: runtime.readiness,
    sendTerminalFrame: (
      route: RelayV2TerminalRuntimeBinding,
      frame: RelayV2JsonObject,
      responseLineage?: RelayV2TerminalOpenResponseLineage,
    ) => runtime.routeSink.sendTerminalFrame(route, frame, responseLineage),
    dispose(): void {
      if (lifecycleDisposed) return;
      lifecycleDisposed = true;
      acceptingBindings = false;
      try {
        runtime.dispose();
      } finally {
        try {
          actor!.dispose();
        } finally {
          bridgeActive = false;
          bindings.clear();
        }
      }
    },
  });
}
