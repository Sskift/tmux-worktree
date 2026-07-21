import {
  activateRelayV2BrokerHostWssListenerFreeComposition,
  type RelayV2BrokerHostWssListenerFreeComposition,
  type RelayV2BrokerHostWssListenerFreeCredentialActivationOptions,
} from "./brokerHostWssListenerFreeComposition.js";
import {
  createRelayV2BrokerHostWssNodeUpgradeRequestAdapter,
  type RelayV2BrokerHostWssNodeUpgradeRequestAdapter,
} from "./brokerHostWssNodeUpgradeRequestAdapter.js";

function failure(): Error {
  return new Error(
    "Relay v2 Broker Host WSS Node listener-free ingress activation failed",
  );
}

/**
 * Default-off credential-activated Node Host ingress. B7l remains the sole
 * credential/runtime owner and B7k remains the sole request/close owner.
 */
export async function activateRelayV2BrokerHostWssNodeListenerFreeIngress(
  options: RelayV2BrokerHostWssListenerFreeCredentialActivationOptions,
): Promise<RelayV2BrokerHostWssNodeUpgradeRequestAdapter> {
  let composition: RelayV2BrokerHostWssListenerFreeComposition;
  try {
    composition = await activateRelayV2BrokerHostWssListenerFreeComposition(
      options,
    );
  } catch {
    throw failure();
  }

  try {
    return createRelayV2BrokerHostWssNodeUpgradeRequestAdapter(composition);
  } catch {
    try {
      await composition.closeAndDrain();
    } catch {
      // Construction failure remains the only public diagnostic.
    }
    throw failure();
  }
}
