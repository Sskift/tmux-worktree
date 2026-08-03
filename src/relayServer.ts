import { parseRelayServerOptions } from "./relay/broker/options.js";
import {
  startRelayBroker as startRelayBrokerRuntime,
  type RelayBrokerServerHandle,
  type RelayV2BrokerServerComposition,
} from "./relay/broker/server.js";
import {
  startRelayV2BrokerPublicHttpsServerLifecycle,
  type RelayV2BrokerPublicHttpsListenOptions,
  type RelayV2BrokerPublicHttpsServerHandle,
} from "./relay/v2/brokerPublicHttpsServer.js";
import type { Server as NodeHttpsServer } from "node:https";
import type { RelayServerOptions } from "./relay/broker/options.js";
import { createRelayV2HostBootstrapOutputSink } from "./relay/broker/hostBootstrapOutput.js";

export type {
  RelayBrokerServerHandle,
  RelayV2BrokerServerAgentCapabilityReadinessReceipt,
  RelayV2BrokerServerComposition,
  RelayV2BrokerServerCredentialAuthority,
} from "./relay/broker/server.js";
export type {
  RelayV2BrokerPublicHttpsListenOptions,
  RelayV2BrokerPublicHttpsServerHandle,
} from "./relay/v2/brokerPublicHttpsServer.js";
export type {
  RelayV2BrokerLocalAdminPort,
  RelayV2BrokerShippingDeploymentInputs,
  RelayV2BrokerShippingPrivilegedResolver,
  RelayV2BrokerShippingProfile,
  RelayV2BrokerShippingRootHandle,
} from "./relay/v2/brokerShippingRoot.js";

/** Explicit opt-in wrapper; the CLI calls it without a v2 composition. */
export async function startRelayBroker(
  options: RelayServerOptions,
  relayV2Composition?: RelayV2BrokerServerComposition,
): Promise<RelayBrokerServerHandle> {
  const relayV2 = relayV2Composition === undefined
    ? undefined
    : await (await import("./relay/v2/brokerServerRuntime.js"))
        .createActivatedRelayV2BrokerServerRuntime(relayV2Composition);
  return startRelayBrokerRuntime(options, relayV2);
}

/**
 * Explicit default-off Relay v2 public transport root. The caller supplies an
 * already TLS-configured, otherwise unowned node:https Server; this function
 * activates the existing canonical v2 runtime before attaching or listening.
 */
export async function startRelayV2BrokerPublicHttpsServer(
  server: NodeHttpsServer,
  options: RelayV2BrokerPublicHttpsListenOptions,
  composition: RelayV2BrokerServerComposition,
): Promise<RelayV2BrokerPublicHttpsServerHandle> {
  return startRelayV2BrokerPublicHttpsServerLifecycle(
    server,
    options,
    async () => (await import("./relay/v2/brokerServerRuntime.js"))
      .createActivatedRelayV2BrokerServerRuntime(composition),
  );
}

/**
 * Explicit default-off Relay v2 shipping root. The reference-only profile and
 * deployment-provided privileged inputs are validated and all durable
 * authorities are opened before any listener binds; without injectable
 * deployment inputs the CLI has no trusted resolver/E0 channel and this fails
 * closed — it never falls back to Relay v1.
 */
export async function startRelayV2BrokerShippingRoot(
  profile: unknown,
  deploymentInputs: import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingDeploymentInputs,
): Promise<import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle> {
  return (await import("./relay/v2/brokerShippingRoot.js"))
    .startRelayV2BrokerShippingRoot(profile, deploymentInputs);
}

export async function startRelayV2BrokerShippingFromProfileFile(
  profilePath: string,
  deploymentInputs?: import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingDeploymentInputs,
): Promise<import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle> {
  return (await import("./relay/v2/brokerShippingRoot.js"))
    .startRelayV2BrokerShippingFromProfileFile(profilePath, deploymentInputs);
}

/**
 * Explicit default-off Relay v2 shipping activation through the single trusted
 * deployment source owner: the reference-only profile's TLS/keyring/E0
 * material resolves only from fd-bound 0600 private files under the fixed
 * trustedHome namespace. Any profile, identifier, ownership, material, E0, or
 * native failure fails closed before any listener — never falling back to v1.
 */
export async function startRelayV2BrokerShippingFromTrustedDeployment(
  profilePath: string,
  agentTranscriptLifecycleReadiness?:
    import("./relay/broker/server.js").RelayV2BrokerServerAgentCapabilityReadinessReceipt,
): Promise<import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle> {
  return (await import("./relay/v2/brokerShippingDeploymentSource.js"))
    .startRelayV2BrokerShippingFromTrustedDeployment(
      profilePath,
      agentTranscriptLifecycleReadiness,
    );
}

/**
 * Explicit loopback-only developer root. It still uses the canonical shipping
 * root but injects process-local, non-durable credential/E0 owners. It is not
 * production qualification and is never selected by default or --v2-profile.
 */
export async function startRelayV2BrokerLocalDevelopment(
  options: import("./relay/v2/brokerLocalDevelopmentActivation.js").RelayV2BrokerLocalDevelopmentOptions,
): Promise<import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle> {
  return (await import("./relay/v2/brokerLocalDevelopmentActivation.js"))
    .startRelayV2BrokerLocalDevelopment(options);
}

/**
 * Explicit non-production Linux x64 single-node root. It keeps the canonical
 * Broker shipping/credential/HTTPS/WSS owners and injects one co-located
 * SQLite storage/continuity/keyring owner. Callers may explicitly supply the
 * independent optional Agent routing receipt in `options`; the CLI omits it.
 * The co-located continuity is not E0 and this entry never changes production
 * qualification or falls back to v1.
 */
export async function startRelayV2BrokerSingleNodeSelfHosted(
  options: import("./relay/v2/brokerSingleNodeSelfHostedActivation.js").RelayV2BrokerSingleNodeSelfHostedOptions,
  signal?: AbortSignal,
): Promise<import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle> {
  return (await import("./relay/v2/brokerSingleNodeSelfHostedActivation.js"))
    .startRelayV2BrokerSingleNodeSelfHosted(options, signal);
}

function createSelfHostedAgentTranscriptLifecycleReadiness():
  import("./relay/broker/server.js").RelayV2BrokerServerAgentCapabilityReadinessReceipt {
  const cancel = Object.freeze((): void => {});
  const subscribeLoss = Object.freeze((_onLoss: () => void): (() => void) => cancel);
  return Object.freeze({ status: "ready" as const, subscribeLoss });
}

class RelayV2BrokerCliSignalLatch {
  readonly #controller = new AbortController();
  readonly #stopped: Promise<void>;
  #resolveStopped!: () => void;
  #closed = false;

  readonly #stop = (): void => {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort();
    this.#resolveStopped();
  };

  constructor() {
    this.#stopped = new Promise((resolve) => {
      this.#resolveStopped = resolve;
    });
    process.once("SIGINT", this.#stop);
    process.once("SIGTERM", this.#stop);
    process.once("SIGHUP", this.#stop);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  wait(): Promise<void> {
    return this.#stopped;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    process.off("SIGINT", this.#stop);
    process.off("SIGTERM", this.#stop);
    process.off("SIGHUP", this.#stop);
  }
}

async function runRelayV2BrokerSingleNodeSelfHostedCli(
  options: RelayServerOptions,
): Promise<void> {
  // This owner exists before any TLS/state/SQLite/listener activation. A
  // signal permanently fences bootstrap publication; any non-interruptible
  // activation/admin await is followed by the same one-shot root drain.
  const signalLatch = new RelayV2BrokerCliSignalLatch();
  let handle:
    import("./relay/v2/brokerShippingRoot.js").RelayV2BrokerShippingRootHandle
    | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (handle === null) return Promise.resolve();
    if (shutdownPromise === null) shutdownPromise = handle.shutdown();
    return shutdownPromise;
  };
  try {
    try {
      handle = await startRelayV2BrokerSingleNodeSelfHosted({
        host: options.host,
        port: options.port,
        advertisedOrigin: options.v2LocalDevelopmentAdvertisedOrigin!,
        tlsKeyPath: options.v2LocalDevelopmentTlsKeyPath!,
        tlsCertificatePath: options.v2LocalDevelopmentTlsCertificatePath!,
        stateDirectory: options.v2SingleNodeSelfHostedStateDirectory!,
        ...(options.v2AgentTranscriptLifecycleV1 === true
          ? {
              agentTranscriptLifecycleReadiness:
                createSelfHostedAgentTranscriptLifecycleReadiness(),
            }
          : {}),
      }, signalLatch.signal);
    } catch (error) {
      if (signalLatch.signal.aborted) return;
      throw error;
    }
    if (signalLatch.signal.aborted) {
      await shutdown();
      return;
    }

    if (options.v2HostBootstrapOutputPath !== undefined) {
      const bootstrapSink = createRelayV2HostBootstrapOutputSink(
        options.v2HostBootstrapOutputPath,
      );
      try {
        const guardedSink = (secret: string): void => {
          if (signalLatch.signal.aborted) {
            throw new Error("Relay v2 Broker startup stopped");
          }
          bootstrapSink(secret);
        };
        if (
          options.v2SingleNodeSelfHostedBootstrapCorrelation === undefined
        ) {
          await handle.admin.createHostBootstrap({}, guardedSink);
        } else {
          await handle.admin.publishHostBootstrap({
            correlation:
              options.v2SingleNodeSelfHostedBootstrapCorrelation,
          }, guardedSink);
        }
      } catch (error) {
        await shutdown();
        if (signalLatch.signal.aborted) return;
        throw error;
      }
    }
    if (signalLatch.signal.aborted) {
      await shutdown();
      return;
    }

    await signalLatch.wait();
    await shutdown();
  } finally {
    signalLatch.close();
    if (handle !== null) await shutdown();
  }
}

/** Stable CLI/tsup facade for the Relay v1 broker implementation. */
export async function run(): Promise<void> {
  const options = parseRelayServerOptions(process.argv.slice(3));
  if (options.v2LocalDevelopment === true) {
    const bootstrapSink = createRelayV2HostBootstrapOutputSink(
      options.v2HostBootstrapOutputPath!,
    );
    const handle = await startRelayV2BrokerLocalDevelopment({
      port: options.port,
      tlsKeyPath: options.v2LocalDevelopmentTlsKeyPath!,
      tlsCertificatePath: options.v2LocalDevelopmentTlsCertificatePath!,
      ...(options.v2LocalDevelopmentAdvertisedOrigin === undefined
        ? {}
        : { advertisedOrigin: options.v2LocalDevelopmentAdvertisedOrigin }),
    });
    try {
      await handle.admin.createHostBootstrap({}, bootstrapSink);
    } catch (error) {
      await handle.shutdown();
      throw error;
    }
    return;
  }
  if (options.v2SingleNodeSelfHosted === true) {
    await runRelayV2BrokerSingleNodeSelfHostedCli(options);
    return;
  }
  if (options.v2ProfilePath !== undefined) {
    // 明确的 v2 profile 选路：只经唯一 trusted deployment activation/source
    // owner 解析 TLS/issuer keyring/E0 material——全部来自 profile trustedHome
    // 下固定 namespace（.tmux-worktree/relay-v2-broker-deployment/）按 identifier
    // 映射的 fd-bound regular-file/no-symlink、owner、exact 0600/0700、bounded
    // 私有文件；任何 profile/reference/ownership/TLS/E0/keyring/native 失败仍在
    // 任何监听前 fail closed，绝不回退 v1；qualifiedRecords=[] 与 NO-GO 不变。
    const bootstrapSink = options.v2HostBootstrapOutputPath === undefined
      ? undefined
      : createRelayV2HostBootstrapOutputSink(options.v2HostBootstrapOutputPath);
    const handle = await startRelayV2BrokerShippingFromTrustedDeployment(options.v2ProfilePath);
    if (bootstrapSink !== undefined) {
      try {
        await handle.admin.createHostBootstrap({}, bootstrapSink);
      } catch (error) {
        await handle.shutdown();
        throw error;
      }
    }
    return;
  }
  await startRelayBroker(options);
}
