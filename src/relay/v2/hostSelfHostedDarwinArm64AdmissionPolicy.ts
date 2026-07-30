import { types as nodeTypes } from "node:util";

declare const relayV2HostSelfHostedDarwinArm64AdmissionPolicyBrand: unique symbol;

/**
 * Fieldless process-local selection ticket for the explicit non-production
 * Darwin arm64 self-hosted lane. It carries no path, credential, descriptor,
 * qualification, or deployment material.
 */
export interface RelayV2HostSelfHostedDarwinArm64AdmissionPolicy {
  readonly [relayV2HostSelfHostedDarwinArm64AdmissionPolicyBrand]: void;
}

const issued = new WeakSet<object>();

function invalidPolicy(): Error {
  return new Error("Relay v2 Host self-hosted Darwin arm64 admission policy is invalid");
}

/**
 * Deployment-owner issuer. Unsupported targets fail closed and cannot create
 * a ticket that a loader might reinterpret as another target.
 */
export function issueRelayV2HostSelfHostedDarwinArm64AdmissionPolicy(
): RelayV2HostSelfHostedDarwinArm64AdmissionPolicy {
  if (arguments.length !== 0
    || process.platform !== "darwin"
    || process.arch !== "arm64") {
    throw invalidPolicy();
  }
  const ticket =
    Object.freeze(Object.create(null)) as RelayV2HostSelfHostedDarwinArm64AdmissionPolicy;
  issued.add(ticket as object);
  return ticket;
}

/**
 * Fixed-loader one-shot consumer. Forged, copied, Proxy, cross-process
 * serialized, or replayed values are rejected before native resolution.
 */
export function takeRelayV2HostSelfHostedDarwinArm64AdmissionPolicy(
  value: unknown,
): void {
  if (arguments.length !== 1
    || value === null
    || typeof value !== "object") throw invalidPolicy();
  try {
    if (nodeTypes.isProxy(value)) throw invalidPolicy();
  } catch {
    throw invalidPolicy();
  }
  if (!issued.delete(value as object)) throw invalidPolicy();
}
