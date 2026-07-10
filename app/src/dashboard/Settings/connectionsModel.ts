import type { AddHostInput, HostConfig } from "../../platform";

export const HOST_DRAFT_FIELDS = [
  "id",
  "label",
  "host",
  "user",
  "port",
  "identityFile",
  "worktreeBase",
  "tmuxPath",
  "twPath",
] as const;

export type HostDraftField = (typeof HOST_DRAFT_FIELDS)[number];

export type HostDraft = Record<HostDraftField, string>;

export type HostDraftErrors = Partial<Record<HostDraftField, string>>;

export interface HostDraftValidationOptions {
  existingHosts?: readonly Pick<HostConfig, "id">[];
  editingHostId?: string | null;
}

export type HostDraftValidation =
  | { valid: true; errors: HostDraftErrors; value: AddHostInput }
  | { valid: false; errors: HostDraftErrors; value: null };

export interface HostImpactSource {
  hostId?: string | null;
}

export interface HostRemovalImpact {
  sessions: number;
  terminals: number;
  total: number;
}

export type RelayConnectionState =
  | "stopped"
  | "starting"
  | "connected"
  | "retrying"
  | "error";

export type RelaySummaryTone = "neutral" | "progress" | "success" | "warning" | "danger";

export interface RelayStatusSnapshot {
  statusKnown?: boolean;
  connectionState: RelayConnectionState;
  active: boolean;
  connected: boolean;
  error?: string | null;
}

export interface RelayStatusSummary {
  label: string;
  detail: string;
  tone: RelaySummaryTone;
}

export interface RelayDraft {
  relayUrl: string;
  brokerHostId: string;
  hostId: string;
  token: string;
}

export type RelayActionIntent = "save" | "start" | "startBroker";

export type RelayDraftErrors = Partial<Record<keyof RelayDraft, string>>;

export type RelayDraftValidation =
  | { valid: true; errors: RelayDraftErrors }
  | { valid: false; errors: RelayDraftErrors };

const optional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed || undefined;
};

export function createEmptyHostDraft(): HostDraft {
  return {
    id: "",
    label: "",
    host: "",
    user: "",
    port: "",
    identityFile: "",
    worktreeBase: "",
    tmuxPath: "",
    twPath: "",
  };
}

export function hostConfigToDraft(host: HostConfig): HostDraft {
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    user: host.user ?? "",
    port: host.port === null || host.port === undefined ? "" : String(host.port),
    identityFile: host.identityFile ?? "",
    worktreeBase: host.worktreeBase ?? "",
    tmuxPath: host.tmuxPath ?? "",
    twPath: host.twPath ?? "",
  };
}

export function stableHostId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

export function sshCandidateToDraft(candidate: HostConfig): HostDraft {
  return {
    ...hostConfigToDraft(candidate),
    id: stableHostId(candidate.id || candidate.host),
    label: (candidate.label || candidate.id || candidate.host).trim(),
    host: (candidate.host || candidate.id).trim(),
  };
}

export function validateHostDraft(
  draft: HostDraft,
  options: HostDraftValidationOptions = {},
): HostDraftValidation {
  const errors: HostDraftErrors = {};
  const id = draft.id.trim();
  const label = draft.label.trim();
  const host = draft.host.trim();

  if (!id) {
    errors.id = "Host ID is required.";
  } else if (id.includes(":")) {
    errors.id = "Host ID cannot contain a colon.";
  } else if (/\s/.test(id)) {
    errors.id = "Host ID cannot contain spaces.";
  } else if (options.editingHostId && id !== options.editingHostId) {
    errors.id = "Host ID is stable and cannot be changed.";
  } else if (
    options.existingHosts?.some(
      (existing) => existing.id === id && existing.id !== options.editingHostId,
    )
  ) {
    errors.id = `Host ID “${id}” already exists.`;
  }

  if (!label) errors.label = "Label is required.";
  if (!host) errors.host = "Host is required.";

  let port: number | undefined;
  const portText = draft.port.trim();
  if (portText) {
    const parsedPort = Number(portText);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      errors.port = "Port must be a whole number from 1 to 65535.";
    } else {
      port = parsedPort;
    }
  }

  if (Object.keys(errors).length > 0) return { valid: false, errors, value: null };

  return {
    valid: true,
    errors,
    value: {
      id,
      label,
      host,
      ...(optional(draft.user) ? { user: optional(draft.user) } : {}),
      ...(port === undefined ? {} : { port }),
      ...(optional(draft.identityFile) ? { identityFile: optional(draft.identityFile) } : {}),
      ...(optional(draft.worktreeBase) ? { worktreeBase: optional(draft.worktreeBase) } : {}),
      ...(optional(draft.tmuxPath) ? { tmuxPath: optional(draft.tmuxPath) } : {}),
      ...(optional(draft.twPath) ? { twPath: optional(draft.twPath) } : {}),
    },
  };
}

export function calculateHostRemovalImpact(
  hostId: string,
  sessions: readonly HostImpactSource[],
  terminals: readonly HostImpactSource[],
): HostRemovalImpact {
  const impactedSessions = sessions.filter((session) => session.hostId === hostId).length;
  const impactedTerminals = terminals.filter((terminal) => terminal.hostId === hostId).length;
  return {
    sessions: impactedSessions,
    terminals: impactedTerminals,
    total: impactedSessions + impactedTerminals,
  };
}

export function summarizeRelayStatus(snapshot: RelayStatusSnapshot): RelayStatusSummary {
  if (snapshot.error || snapshot.connectionState === "error") {
    return {
      label: "Error",
      detail: snapshot.error?.trim() || "Relay stopped after an unexpected error.",
      tone: "danger",
    };
  }

  if (snapshot.statusKnown === false) {
    return {
      label: "Checking Relay",
      detail: "Reading the saved configuration and current Relay process state.",
      tone: "progress",
    };
  }

  if (snapshot.connected || snapshot.connectionState === "connected") {
    return {
      label: "Connected",
      detail: "The mobile client can reach this dashboard through Relay.",
      tone: "success",
    };
  }

  if (snapshot.connectionState === "retrying") {
    return {
      label: "Retrying",
      detail: "Relay is reconnecting automatically. Your configuration is preserved.",
      tone: "warning",
    };
  }

  if (snapshot.active || snapshot.connectionState === "starting") {
    return {
      label: "Starting",
      detail: "Relay is establishing a secure connection.",
      tone: "progress",
    };
  }

  return {
    label: "Stopped",
    detail: "Relay is configured locally and is not accepting connections.",
    tone: "neutral",
  };
}

export function validateRelayDraft(
  draft: RelayDraft,
  intent: RelayActionIntent,
): RelayDraftValidation {
  const errors: RelayDraftErrors = {};
  const relayUrl = draft.relayUrl.trim();

  if (!relayUrl) {
    errors.relayUrl = "Relay URL is required.";
  } else {
    try {
      const parsed = new URL(relayUrl);
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        errors.relayUrl = "Relay URL must use ws:// or wss://.";
      }
    } catch {
      errors.relayUrl = "Enter a valid Relay URL.";
    }
  }

  if (!draft.hostId.trim()) errors.hostId = "Host ID is required.";
  if (intent === "start" && !draft.token.trim()) errors.token = "Token is required to start Relay.";
  if (intent === "startBroker" && !draft.brokerHostId.trim()) {
    errors.brokerHostId = "Select a broker host.";
  }

  return Object.keys(errors).length === 0
    ? { valid: true, errors }
    : { valid: false, errors };
}
