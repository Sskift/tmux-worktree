import { parseRelayServerOptions } from "./relay/broker/options.js";
import { startRelayBroker } from "./relay/broker/server.js";

export { startRelayBroker } from "./relay/broker/server.js";
export type {
  RelayBrokerServerHandle,
  RelayV2BrokerServerComposition,
  RelayV2BrokerServerCredentialAuthority,
} from "./relay/broker/server.js";

/** Stable CLI/tsup facade for the Relay v1 broker implementation. */
export async function run(): Promise<void> {
  const options = parseRelayServerOptions(process.argv.slice(3));
  await startRelayBroker(options);
}
