import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { types as nodeUtilTypes } from "node:util";

import {
  activateRelayV2BrokerCombinedWssNodeListenerFreeComposition,
  type RelayV2BrokerCombinedWssNodeListenerFreeComposition,
} from "./brokerHostWssListenerFreeComposition.js";
import {
  handleRelayV2BrokerCredentialNodeHttpRequest,
} from "./brokerCredentialNodeHttpAdapter.js";
import {
  createRelayV2BrokerCredentialExternalContinuityOpener,
} from "./brokerCredentialExternalContinuityOpener.js";
import {
  bindRelayV2ExternalContinuityAuthorityConfig,
  type RelayV2ExternalContinuityAuthorityAttemptProvider,
  type RelayV2ExternalContinuityAuthorityConfig,
} from "./externalContinuityAuthorityConfig.js";
import {
  captureRelayV2BrokerCredentialAuthorityGenesis,
  type RelayV2BrokerCredentialAuthorityGenesis,
} from "./brokerCredentialAuthority.js";
import type { RelayV2BrokerCredentialStateStoreNativeLoader } from "./brokerCredentialStateStoreLoader.js";
import {
  RELAY_V2_REQUIRED_CAPABILITIES,
  type RelayV2BrokerOptionalCapabilityReadinessPort,
} from "./brokerCore.js";
import {
  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
} from "../extensions/agentTranscriptLifecycle/v1/codec.js";
import type {
  RelayV2BrokerServerAgentCapabilityReadinessReceipt,
  RelayV2BrokerServerComposition,
  RelayV2BrokerServerCredentialAuthority,
} from "../broker/server.js";

export interface RelayV2BrokerServerRuntimeV2 {
  handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  admitUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    target: Readonly<{ pathname: string; search: string }>,
    legacyQuerySecret: string | null,
  ): boolean;
  beginShutdown(): void;
  shutdown(): Promise<void>;
}

export interface RelayV2BrokerProductionCompositionBundle {
  readonly trustedHome: string;
  readonly nativeLoader: RelayV2BrokerCredentialStateStoreNativeLoader;
  readonly externalContinuityConfig: RelayV2ExternalContinuityAuthorityConfig;
  readonly externalContinuityAttemptProvider: RelayV2ExternalContinuityAuthorityAttemptProvider;
  readonly genesis: RelayV2BrokerCredentialAuthorityGenesis;
  readonly resolveHttpSourceKey: RelayV2BrokerServerComposition["resolveHttpSourceKey"];
  readonly closeDeadlineScheduler?: RelayV2BrokerServerComposition["closeDeadlineScheduler"];
  readonly agentTranscriptLifecycleReadiness?: RelayV2BrokerServerAgentCapabilityReadinessReceipt;
}

type CapturedProductionBundle = Readonly<{
  trustedHome: string;
  nativeLoader: RelayV2BrokerCredentialStateStoreNativeLoader;
  externalContinuityConfig: RelayV2ExternalContinuityAuthorityConfig;
  externalContinuityAttemptProvider: RelayV2ExternalContinuityAuthorityAttemptProvider;
  genesis: RelayV2BrokerCredentialAuthorityGenesis;
  resolveHttpSourceKey: RelayV2BrokerServerComposition["resolveHttpSourceKey"];
  closeDeadlineScheduler?: RelayV2BrokerServerComposition["closeDeadlineScheduler"];
  agentTranscriptLifecycleReadiness?: RelayV2BrokerServerAgentCapabilityReadinessReceipt;
}>;

function captureProductionBundle(
  value: unknown,
): CapturedProductionBundle {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  const required = [
    "trustedHome",
    "nativeLoader",
    "externalContinuityConfig",
    "externalContinuityAttemptProvider",
    "genesis",
    "resolveHttpSourceKey",
  ] as const;
  const optional = [
    "closeDeadlineScheduler",
    "agentTranscriptLifecycleReadiness",
  ] as const;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")
      || keys.length < required.length
      || keys.some((key) => !required.includes(key as typeof required[number])
        && !optional.includes(key as typeof optional[number]))) {
      throw new Error("invalid production bundle keys");
    }
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (!descriptor) {
        if (required.includes(key as typeof required[number])) {
          throw new Error("missing production bundle dependency");
        }
        continue;
      }
      if (!Object.hasOwn(descriptor, "value") || descriptor.get !== undefined
        || descriptor.set !== undefined) throw new Error("accessor dependency");
    }
  } catch {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  const captured = (key: string): unknown => descriptors[key]?.value;
  const trustedHome = captured("trustedHome");
  const nativeLoader = captured("nativeLoader");
  const externalContinuityConfig = captured("externalContinuityConfig");
  const externalContinuityAttemptProvider = captured("externalContinuityAttemptProvider");
  const genesis = captured("genesis");
  const resolveHttpSourceKey = captured("resolveHttpSourceKey");
  let capturedGenesis: RelayV2BrokerCredentialAuthorityGenesis;
  try {
    capturedGenesis = captureRelayV2BrokerCredentialAuthorityGenesis(
      genesis as RelayV2BrokerCredentialAuthorityGenesis,
    );
  } catch {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  if (typeof trustedHome !== "string" || trustedHome.length === 0
    || !trustedHome.startsWith("/")
    || nativeLoader === null || typeof nativeLoader !== "object"
    || rejectedProxy(nativeLoader)
    || externalContinuityConfig === null || typeof externalContinuityConfig !== "object"
    || rejectedProxy(externalContinuityConfig)
    || externalContinuityAttemptProvider === null
    || typeof externalContinuityAttemptProvider !== "object"
    || rejectedProxy(externalContinuityAttemptProvider)
    || genesis === null || typeof genesis !== "object" || rejectedProxy(genesis)
    || typeof resolveHttpSourceKey !== "function"
    || rejectedProxy(resolveHttpSourceKey)) {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  const scheduler = captured("closeDeadlineScheduler");
  if (scheduler !== undefined && (scheduler === null || typeof scheduler !== "object"
    || rejectedProxy(scheduler))) {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  const agentReadiness = captured("agentTranscriptLifecycleReadiness");
  if (agentReadiness !== undefined && (agentReadiness === null
    || typeof agentReadiness !== "object" || rejectedProxy(agentReadiness))) {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  // Validate all side-effect-free E0 bindings before the native store can open.
  const binding = bindRelayV2ExternalContinuityAuthorityConfig(
    externalContinuityConfig as RelayV2ExternalContinuityAuthorityConfig,
    externalContinuityAttemptProvider as RelayV2ExternalContinuityAuthorityAttemptProvider,
  );
  if (!binding.namespaceBindings.some((candidate) => candidate.namespace === "broker-credential.v1")) {
    throw new TypeError("Relay v2 Broker production composition bundle is invalid");
  }
  return Object.freeze({
    trustedHome,
    nativeLoader: nativeLoader as RelayV2BrokerCredentialStateStoreNativeLoader,
    externalContinuityConfig: externalContinuityConfig as RelayV2ExternalContinuityAuthorityConfig,
    externalContinuityAttemptProvider:
      externalContinuityAttemptProvider as RelayV2ExternalContinuityAuthorityAttemptProvider,
    genesis: capturedGenesis,
    resolveHttpSourceKey:
      resolveHttpSourceKey as RelayV2BrokerServerComposition["resolveHttpSourceKey"],
    ...(scheduler === undefined ? {} : { closeDeadlineScheduler: scheduler }),
    ...(agentReadiness === undefined ? {} : {
      agentTranscriptLifecycleReadiness:
        agentReadiness as RelayV2BrokerServerAgentCapabilityReadinessReceipt,
    }),
  });
}

/**
 * Explicit, default-off E0-to-Broker ownership transfer. This only captures
 * frozen dependencies and delegates execution to the existing activated
 * runtime; it creates no second Core, authority, listener, retry, or ready
 * owner and is intentionally not called by the CLI.
 */
export function createRelayV2BrokerProductionComposition(
  value: unknown,
): RelayV2BrokerServerComposition {
  const bundle = captureProductionBundle(value);
  const opener = createRelayV2BrokerCredentialExternalContinuityOpener({
    trustedHome: bundle.trustedHome,
    nativeLoader: bundle.nativeLoader,
    externalContinuityConfig: bundle.externalContinuityConfig,
    externalContinuityAttemptProvider: bundle.externalContinuityAttemptProvider,
    genesis: bundle.genesis,
  });
  return Object.freeze({
    openCredentialAuthority: (input) => opener(input),
    resolveHttpSourceKey: (socket) => Reflect.apply(
      bundle.resolveHttpSourceKey,
      undefined,
      [socket],
    ),
    ...(bundle.closeDeadlineScheduler === undefined ? {} : {
      closeDeadlineScheduler: bundle.closeDeadlineScheduler,
    }),
    ...(bundle.agentTranscriptLifecycleReadiness === undefined ? {} : {
      agentTranscriptLifecycleReadiness: bundle.agentTranscriptLifecycleReadiness,
    }),
  });
}

function isCompleteAuthority(
  authority: unknown,
): authority is RelayV2BrokerServerCredentialAuthority {
  if (authority === null || typeof authority !== "object") return false;
  const candidate = authority as Record<string, unknown>;
  return [
    "handle",
    "admitHttpSource",
    "releaseHttpSourceAdmission",
    "authorizeAccessToken",
    "bootstrapHost",
    "redeemEnrollment",
    "refreshClientGrantFromHttp",
    "refreshHostGrantFromHttp",
    "selfRevokeGrantFromHttp",
    "close",
  ].every((name) => typeof candidate[name] === "function")
    && candidate.authorityContinuityReadiness !== null
    && typeof candidate.authorityContinuityReadiness === "object"
    && (candidate.authorityContinuityReadiness as { status?: unknown }).status === "ready";
}

type CapturedAgentCapabilityReadiness = Readonly<{
  receiver: RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  subscribeLoss: Function;
}>;

type AgentCapabilityReadinessCapture = Readonly<
  | { outcome: "absent" }
  | { outcome: "invalid" }
  | { outcome: "ready"; readiness: CapturedAgentCapabilityReadiness }
>;

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

function captureAgentCapabilityReadiness(
  composition: RelayV2BrokerServerComposition,
): AgentCapabilityReadinessCapture {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      composition,
      "agentTranscriptLifecycleReadiness",
    );
    if (!descriptor) {
      return Reflect.has(composition, "agentTranscriptLifecycleReadiness")
        ? Object.freeze({ outcome: "invalid" })
        : Object.freeze({ outcome: "absent" });
    }
    if (!Object.hasOwn(descriptor, "value")) {
      return Object.freeze({ outcome: "invalid" });
    }
    const receipt = descriptor.value;
    if (receipt === null || typeof receipt !== "object" || rejectedProxy(receipt)) {
      return Object.freeze({ outcome: "invalid" });
    }
    const descriptors = Object.getOwnPropertyDescriptors(receipt);
    if (
      Reflect.ownKeys(descriptors).length !== 2
      || !Object.hasOwn(descriptors.status ?? {}, "value")
      || descriptors.status?.value !== "ready"
      || !Object.hasOwn(descriptors.subscribeLoss ?? {}, "value")
      || typeof descriptors.subscribeLoss?.value !== "function"
      || rejectedProxy(descriptors.subscribeLoss.value)
    ) return Object.freeze({ outcome: "invalid" });
    return Object.freeze({
      outcome: "ready",
      readiness: Object.freeze({
        receiver: receipt as RelayV2BrokerServerAgentCapabilityReadinessReceipt,
        subscribeLoss: descriptors.subscribeLoss.value,
      }),
    });
  } catch {
    return Object.freeze({ outcome: "invalid" });
  }
}

/**
 * Lifecycle adapter only: readiness remains owned by the injected receipt and
 * capability state remains owned by the one BrokerCore behind the narrow port.
 */
class RelayV2BrokerAgentCapabilityReadinessSubscription {
  private portBound = false;
  private closed = false;
  private lost = false;
  private cancelSubscription: Function | null = null;

  constructor(private readonly readiness: CapturedAgentCapabilityReadiness) {}

  bind(port: RelayV2BrokerOptionalCapabilityReadinessPort): void {
    if (this.portBound || this.closed) {
      throw new Error("Relay v2 Broker optional capability readiness was already bound");
    }
    this.portBound = true;
    const onLoss = (): void => {
      if (this.closed || this.lost) return;
      this.lost = true;
      port.withdraw(RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY);
    };
    let cancel: unknown;
    try {
      cancel = Reflect.apply(
        this.readiness.subscribeLoss,
        this.readiness.receiver,
        [onLoss],
      );
    } catch {
      onLoss();
      return;
    }
    if (typeof cancel !== "function" || rejectedProxy(cancel)) {
      onLoss();
      return;
    }
    this.cancelSubscription = cancel;
    if (this.closed || this.lost) this.cancel();
  }

  get bound(): boolean {
    return this.portBound;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
  }

  private cancel(): void {
    const cancel = this.cancelSubscription;
    this.cancelSubscription = null;
    if (!cancel) return;
    try {
      Reflect.apply(cancel, undefined, []);
    } catch {
      // The callback fence above is already permanent for this composition.
    }
  }
}

function validSourceKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 1_024
    && !value.includes("\0");
}

async function rejectHttpAndDrain(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.shouldKeepAlive = false;
  try { request.resume(); } catch {}
  await new Promise<void>((resolve) => {
    const settled = (): void => {
      response.off("finish", settled);
      response.off("close", settled);
      resolve();
    };
    response.once("finish", settled);
    response.once("close", settled);
    response.writeHead(503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    response.end(JSON.stringify({ ok: false, error: "source unavailable" }));
  });
  if (!request.complete && !request.destroyed && !request.aborted) {
    try { request.destroy(); } catch {}
  }
}

/**
 * Explicit, default-off adoption of the single activated combined WSS owner.
 * It borrows that same credential authority for the five strict HTTP
 * endpoints; only the combined runtime owns its close. No listener, E0 store,
 * secret, retry owner, enrollment, or v1 fallback is created here.
 */
export async function createActivatedRelayV2BrokerServerRuntime(
  composition: RelayV2BrokerServerComposition,
): Promise<RelayV2BrokerServerRuntimeV2> {
  if (
    composition === null
    || typeof composition !== "object"
    || typeof composition.openCredentialAuthority !== "function"
    || typeof composition.resolveHttpSourceKey !== "function"
  ) {
    throw new Error("Relay v2 broker composition is incomplete");
  }

  const capturedAgentReadiness = captureAgentCapabilityReadiness(composition);
  if (capturedAgentReadiness.outcome === "invalid") {
    throw new Error("Relay v2 Broker optional capability readiness is invalid");
  }
  const agentReadinessSubscription = capturedAgentReadiness.outcome === "ready"
    ? new RelayV2BrokerAgentCapabilityReadinessSubscription(
        capturedAgentReadiness.readiness,
      )
    : null;

  let authority: RelayV2BrokerServerCredentialAuthority | null = null;
  let upgradeAuthorizationOpen = true;
  let combined: RelayV2BrokerCombinedWssNodeListenerFreeComposition;
  try {
    combined = await activateRelayV2BrokerCombinedWssNodeListenerFreeComposition({
      async openCredentialAuthority(input) {
        const opened = await composition.openCredentialAuthority(input);
        if (!isCompleteAuthority(opened)) {
          try { await opened?.close?.(); } catch {}
          throw new Error("Relay v2 credential authority is not ready");
        }
        authority = opened;
        return Object.freeze({
          authorityContinuityReadiness: opened.authorityContinuityReadiness,
          handle: (request: Parameters<typeof opened.handle>[0]) => opened.handle(request),
          async authorizeAccessToken(
            token: string,
            role: Parameters<typeof opened.authorizeAccessToken>[1],
          ) {
            if (!upgradeAuthorizationOpen) {
              throw Object.assign(
                new Error("Relay v2 Broker Upgrade admission is sealed"),
                { code: "CAPABILITY_UNAVAILABLE" },
              );
            }
            const authorization = await opened.authorizeAccessToken(token, role);
            if (!upgradeAuthorizationOpen) {
              throw Object.assign(
                new Error("Relay v2 Broker Upgrade admission was sealed"),
                { code: "CAPABILITY_UNAVAILABLE" },
              );
            }
            return authorization;
          },
          close: () => opened.close(),
        });
      },
      sharedRuntimeOptions: {
        brokerOptions: {
          baseCapabilityReadiness: [...RELAY_V2_REQUIRED_CAPABILITIES],
          ...(agentReadinessSubscription
            ? {
                optionalCapabilityReadiness: [
                  RELAY_AGENT_TRANSCRIPT_LIFECYCLE_CAPABILITY,
                ],
              }
            : {}),
        },
        ...(agentReadinessSubscription
          ? {
              bindOptionalCapabilityReadinessPort: (
                port: RelayV2BrokerOptionalCapabilityReadinessPort,
              ) => agentReadinessSubscription.bind(port),
            }
          : {}),
        ...(composition.closeDeadlineScheduler === undefined
          ? {}
          : { transportCloseDeadlineScheduler: composition.closeDeadlineScheduler }),
      },
    });
  } catch {
    agentReadinessSubscription?.close();
    throw new Error("Relay v2 broker activated composition failed to open");
  }
  if (!authority || (agentReadinessSubscription && !agentReadinessSubscription.bound)) {
    agentReadinessSubscription?.close();
    try { await combined.closeAndDrain(); } catch {}
    throw new Error(!authority
      ? "Relay v2 credential authority is unavailable"
      : "Relay v2 Broker optional capability readiness is unavailable");
  }

  const upgradeAttempts = new Set<Promise<void>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const runtime: RelayV2BrokerServerRuntimeV2 = {
    async handleHttpRequest(request, response) {
      let sourceKey: unknown;
      try {
        sourceKey = composition.resolveHttpSourceKey(request.socket);
      } catch {
        sourceKey = null;
      }
      if (!validSourceKey(sourceKey)) {
        await rejectHttpAndDrain(request, response);
        return;
      }
      await handleRelayV2BrokerCredentialNodeHttpRequest(
        authority!,
        sourceKey,
        request,
        response,
      );
    },

    admitUpgrade(request, socket, head, target) {
      if (shuttingDown) return false;
      let tracked: Promise<void>;
      tracked = Promise.resolve().then(async () => {
        if (shuttingDown) {
          try { socket.destroy(); } catch {}
          return;
        }
        const input = Object.freeze({
          request,
          socket,
          head: new Uint8Array(head.buffer, head.byteOffset, head.byteLength),
        });
        if (target.pathname === "/host") {
          await combined.handleHostUpgradeRequest(input);
        } else {
          await combined.handleClientUpgradeRequest(input);
        }
      }).catch(() => {
        try { socket.destroy(); } catch {}
      }).finally(() => {
        upgradeAttempts.delete(tracked);
      });
      upgradeAttempts.add(tracked);
      return true;
    },

    beginShutdown() {
      shuttingDown = true;
      upgradeAuthorizationOpen = false;
      agentReadinessSubscription?.close();
    },

    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      runtime.beginShutdown();
      shutdownPromise = (async () => {
        await Promise.all([...upgradeAttempts]);
        await combined.closeAndDrain();
      })();
      return shutdownPromise;
    },
  };
  return runtime;
}
