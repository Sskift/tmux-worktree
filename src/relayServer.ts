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

export type {
  RelayBrokerServerHandle,
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

/** Stable CLI/tsup facade for the Relay v1 broker implementation. */
export async function run(): Promise<void> {
  const options = parseRelayServerOptions(process.argv.slice(3));
  if (options.v2ProfilePath !== undefined) {
    // 明确的 v2 profile 选路：解析并校验 profile 后，CLI 无受信 deployment
    // resolver/E0 attempt provider 来源，在任何监听前 fail closed；不回退 v1。
    await startRelayV2BrokerShippingFromProfileFile(options.v2ProfilePath);
    return;
  }
  await startRelayBroker(options);
}
