import type {
  RelayV2HostH1ReadinessActivation,
  RelayV2HostH1ReadinessActivationOptions,
} from "./hostCommandPlane.js";

type HostCommandPlaneH1ActivationModule = Pick<
  typeof import("./hostCommandPlane.js"),
  "createRelayV2HostH1ReadinessActivation"
>;

// Root ESM entries are independently bundled with splitting disabled. Keep
// this import external so candidate issuance and one-shot capture always use
// the same hostCommandPlane entry instance and therefore the same WeakMap.
const HOST_COMMAND_PLANE_ENTRY_URL = new URL("./hostCommandPlane.js", import.meta.url).href;
const hostCommandPlaneH1ActivationModule = await import(HOST_COMMAND_PLANE_ENTRY_URL) as
  HostCommandPlaneH1ActivationModule;
const createRegisteredH1Activation =
  hostCommandPlaneH1ActivationModule.createRelayV2HostH1ReadinessActivation;
if (typeof createRegisteredH1Activation !== "function") {
  throw new Error("Relay v2 H1 recovery candidate capture seam is unavailable");
}

export type {
  RelayV2HostH1ReadinessActivation,
  RelayV2HostH1ReadinessActivationOptions,
};

export interface RelayV2HostH1ReadinessLifecycle {
  close(): Promise<void>;
}

export function createRelayV2HostH1ReadinessActivation(
  options: RelayV2HostH1ReadinessActivationOptions,
): RelayV2HostH1ReadinessActivation | null {
  return createRegisteredH1Activation(options);
}
