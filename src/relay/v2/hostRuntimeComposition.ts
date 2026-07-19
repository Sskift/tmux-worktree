import type { RelayV2JsonObject } from "./codecSchema.js";
import type {
  RelayV2HostCarrierRouteSink,
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
