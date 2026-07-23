import { parseRelayServerOptions } from "./relay/broker/options.js";
import {
  startRelayBroker as startRelayBrokerRuntime,
  type RelayBrokerServerHandle,
  type RelayV2BrokerServerComposition,
} from "./relay/broker/server.js";
import type { RelayServerOptions } from "./relay/broker/options.js";

export type {
  RelayBrokerServerHandle,
  RelayV2BrokerServerComposition,
  RelayV2BrokerServerCredentialAuthority,
} from "./relay/broker/server.js";

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

/** Stable CLI/tsup facade for the Relay v1 broker implementation. */
export async function run(): Promise<void> {
  const options = parseRelayServerOptions(process.argv.slice(3));
  await startRelayBroker(options);
}
