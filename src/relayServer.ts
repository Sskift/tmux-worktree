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

/** Stable CLI/tsup facade for the Relay v1 broker implementation. */
export async function run(): Promise<void> {
  const options = parseRelayServerOptions(process.argv.slice(3));
  await startRelayBroker(options);
}
