import type { RpcV2Session } from "../../rpcV2.js";
import {
  issueRelayV2CanonicalBackendInstanceKey,
  type RelayV2CanonicalBackendScopeIdentity,
} from "./canonicalBackendIdentity.js";
import type {
  RelayV2DiscoveredSession,
  RelayV2DiscoveredReservationCorrelation,
} from "./resourceState.js";

export interface RelayV2CanonicalTwRpcDiscoveryInput {
  backendScope: RelayV2CanonicalBackendScopeIdentity;
  session: RpcV2Session;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function persistedDisplayLabel(session: RpcV2Session): string {
  if (typeof session.label !== "string"
    || session.label.length === 0
    || session.label.trim() !== session.label
    || session.label.includes("\0")
    || Buffer.byteLength(session.label, "utf8") > 128) {
    throw new TypeError("canonical TW RPC Session lacks a persisted display label");
  }
  return session.label;
}

function sessionTimes(session: RpcV2Session): { createdAtMs: number; activityAtMs: number } {
  const createdAtMs = Date.parse(session.createdAt);
  const activityAtMs = session.activity * 1_000;
  if (!Number.isSafeInteger(createdAtMs)
    || !Number.isSafeInteger(activityAtMs)
    || createdAtMs < 0
    || activityAtMs < 0) {
    throw new TypeError("canonical TW RPC Session time evidence is invalid");
  }
  return { createdAtMs, activityAtMs };
}

/**
 * Canonical TW RPC discovery projection for the H2 discovery seam. It consumes
 * the persisted public label and shared backend identity owner; raw tmux names
 * and public Relay Session IDs never participate in either projection.
 */
export function projectRelayV2CanonicalTwRpcDiscoveredSession(
  input: RelayV2CanonicalTwRpcDiscoveryInput,
): RelayV2DiscoveredSession {
  const { session } = input;
  const displayName = persistedDisplayLabel(session);
  const times = sessionTimes(session);
  if (session.kind === "worktree") {
    if (session.project === null
      || session.repoPath === null
      || session.worktreePath === null
      || session.branch === null
      || session.baseBranch === null
      || session.cwd !== session.worktreePath) {
      throw new TypeError("canonical TW RPC worktree Session is incomplete");
    }
  } else if (session.project !== null
    || session.repoPath !== null
    || session.worktreePath !== null
    || session.branch !== null
    || session.baseBranch !== null) {
    throw new TypeError("canonical TW RPC terminal Session has worktree fields");
  }
  const reservationCorrelation = session.reservationCorrelation === null
    ? null
    : clone(session.reservationCorrelation) as RelayV2DiscoveredReservationCorrelation;
  return {
    backendIdentity: issueRelayV2CanonicalBackendInstanceKey({
      backendScope: input.backendScope,
      rpcIncarnation: session.incarnation,
    }),
    kind: session.kind,
    displayName,
    state: "running",
    project: session.project,
    label: session.kind === "terminal" ? displayName : null,
    cwd: session.cwd,
    attached: session.attached,
    windowCount: session.windows,
    ...times,
    ...(reservationCorrelation === null ? {} : { reservationCorrelation }),
  };
}
