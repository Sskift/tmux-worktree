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
