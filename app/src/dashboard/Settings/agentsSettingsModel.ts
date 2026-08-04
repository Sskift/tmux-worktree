import type { AgentProbeTarget, HostConfig } from "../../platform/domainTypes";

export const LOCAL_AGENT_TARGET_KEY = "local";
const HOST_AGENT_TARGET_PREFIX = "host:";

export type AgentProbeTargetOption = {
  value: string;
  label: string;
  detail?: string;
};

export function agentProbeTargetKey(target: AgentProbeTarget): string {
  return target.kind === "host"
    ? `${HOST_AGENT_TARGET_PREFIX}${target.hostId}`
    : LOCAL_AGENT_TARGET_KEY;
}

export function resolveAgentProbeTarget(
  key: string,
  hosts: readonly HostConfig[],
): AgentProbeTarget {
  if (!key.startsWith(HOST_AGENT_TARGET_PREFIX)) return { kind: "local" };
  const hostId = key.slice(HOST_AGENT_TARGET_PREFIX.length);
  return hosts.some((host) => host.id === hostId)
    ? { kind: "host", hostId }
    : { kind: "local" };
}

export function buildAgentProbeTargetOptions(
  hosts: readonly HostConfig[],
): AgentProbeTargetOption[] {
  return [
    { value: LOCAL_AGENT_TARGET_KEY, label: "This Mac", detail: "Local environment" },
    ...hosts.map((host) => ({
      value: agentProbeTargetKey({ kind: "host", hostId: host.id }),
      label: host.label || host.id,
      detail: host.user ? `${host.user}@${host.host}` : host.host,
    })),
  ];
}
