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
import type {
  RelayV2TerminalOpenResponseLineage,
  RelayV2TerminalRuntimeBinding,
} from "./terminalManager.js";

type NonH2ReadinessSource = Exclude<RelayV2HostCapabilityReadinessSource, "h2">;

/**
 * H2 has no ready ingress in this slice. The existing H2 and spool owners do
 * not issue one opaque, owner-verified subscription/receipt that exact-binds
 * hostId, hostEpoch, hostInstanceId, owner fence, cut source and the same cut.
 * A consumer may only withdraw the already-false source until that owner seam
 * exists in a later slice.
 */
export interface RelayV2HostRuntimeCompositionH2ReadinessWithdrawal {
  close(): void;
}

export interface RelayV2HostRuntimeCompositionReadinessLifecycle {
  readonly codec: RelayV2HostCapabilityReadinessSourceSink<"codec">;
  readonly carrier: RelayV2HostCapabilityReadinessSourceSink<"carrier">;
  readonly h0: RelayV2HostCapabilityReadinessSourceSink<"h0">;
  readonly h1: RelayV2HostCapabilityReadinessSourceSink<"h1">;
  readonly h2: RelayV2HostRuntimeCompositionH2ReadinessWithdrawal;
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

export interface RelayV2HostRuntimeCompositionOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  authorities: RelayV2HostRuntimeActualAuthorityInput;
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
  const readinessOwner = new RelayV2HostCapabilityReadiness();
  const rawSources = Object.freeze({
    codec: readinessOwner.source("codec"),
    carrier: readinessOwner.source("carrier"),
    h0: readinessOwner.source("h0"),
    h1: readinessOwner.source("h1"),
    h2: readinessOwner.source("h2"),
    h3: readinessOwner.source("h3"),
  });
  const authorityPorts = createRelayV2HostRuntimeAuthorityPorts(options.authorities);
  const runtime = new RelayV2HostRuntime({
    hostId: options.hostId,
    hostEpoch: options.hostEpoch,
    hostInstanceId: options.hostInstanceId,
    ...authorityPorts,
    capabilityIntersection: readinessOwner,
    welcome: options.welcome,
    outbound: options.outbound,
    testLimits: options.testLimits,
  });
  let disposed = false;
  const isDisposed = () => disposed;

  const h2: RelayV2HostRuntimeCompositionH2ReadinessWithdrawal = Object.freeze({
    close(): void {
      if (!disposed) rawSources.h2.close();
    },
  });

  const readiness: RelayV2HostRuntimeCompositionReadinessLifecycle = Object.freeze({
    codec: guardedSource(rawSources.codec, isDisposed),
    carrier: guardedSource(rawSources.carrier, isDisposed),
    h0: guardedSource(rawSources.h0, isDisposed),
    h1: guardedSource(rawSources.h1, isDisposed),
    h2,
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
      for (const source of Object.values(rawSources)) source.close();
      runtime.dispose();
    },
  });
}
