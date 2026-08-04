import {
  createLatestRequestGate,
  requestSourceKey,
  type LatestRequestGate,
  type LatestRequestToken,
} from "../../latestRequestGate";
import type { HostConfig } from "../../platform";

export type ConnectionsAsyncScope = "hostFeedback" | "hostCatalog" | "relay";

export type ConnectionsAsyncToken = LatestRequestToken & Readonly<{
  scope: ConnectionsAsyncScope;
}>;

export type ConnectionsAsyncCoordinator = {
  issue(
    scope: ConnectionsAsyncScope,
    ...identity: ReadonlyArray<string | number | boolean | null | undefined>
  ): ConnectionsAsyncToken;
  isCurrent(token: ConnectionsAsyncToken): boolean;
  invalidate(scope: ConnectionsAsyncScope): void;
  invalidateAll(): void;
};

/**
 * React parents frequently rebuild arrays, so reference identity cannot tell
 * whether a Host catalog actually changed. Keep the backend-defined order and
 * every persisted field in a deterministic fingerprint instead.
 */
export function hostCatalogFingerprint(hosts: readonly HostConfig[]): string {
  return JSON.stringify(hosts.map((host) => [
    host.id,
    host.label,
    host.host,
    host.user ?? null,
    host.port ?? null,
    host.identityFile ?? null,
    host.worktreeBase ?? null,
    host.tmuxPath ?? null,
    host.twPath ?? null,
  ]));
}

/**
 * Host mutations have two independent destinations: selection-specific editor
 * feedback and the authoritative Host catalog returned by Rust. Switching the
 * selected Host invalidates only the former; a later catalog mutation or an
 * external catalog revision invalidates the latter. Relay feedback remains
 * independent from both.
 */
export function createConnectionsAsyncCoordinator(): ConnectionsAsyncCoordinator {
  const gates: Record<ConnectionsAsyncScope, LatestRequestGate> = {
    hostFeedback: createLatestRequestGate(),
    hostCatalog: createLatestRequestGate(),
    relay: createLatestRequestGate(),
  };

  return {
    issue(scope, ...identity) {
      return {
        scope,
        ...gates[scope].issue(requestSourceKey(...identity)),
      };
    },

    isCurrent(token) {
      return gates[token.scope].isCurrent(token);
    },

    invalidate(scope) {
      gates[scope].invalidate();
    },

    invalidateAll() {
      gates.hostFeedback.invalidate();
      gates.hostCatalog.invalidate();
      gates.relay.invalidate();
    },
  };
}
