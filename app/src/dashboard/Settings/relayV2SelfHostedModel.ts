import type {
  MobileRelayV2SelfHostedConfigInput,
  MobileRelayV2SelfHostedStatus,
} from "../../platform/domainTypes";

export type RelayV2SelfHostedDraft = {
  enabled: boolean;
  brokerHostId: string;
  issuerUrl: string;
  listenHost: string;
  listenPort: string;
  tlsKeyPath: string;
  tlsCertificatePath: string;
  tlsCaPath: string;
  externalTlsManagement: boolean;
};

export type RelayV2SelfHostedDraftErrors = Partial<
  Record<keyof RelayV2SelfHostedDraft, string>
>;

export type RelayV2SelfHostedValidation =
  | {
      valid: true;
      errors: RelayV2SelfHostedDraftErrors;
      value: MobileRelayV2SelfHostedConfigInput;
    }
  | {
      valid: false;
      errors: RelayV2SelfHostedDraftErrors;
      value: null;
    };

export function createRelayV2SelfHostedDraft(): RelayV2SelfHostedDraft {
  return {
    enabled: false,
    brokerHostId: "",
    issuerUrl: "",
    listenHost: "",
    listenPort: "8788",
    tlsKeyPath: "",
    tlsCertificatePath: "",
    tlsCaPath: "",
    externalTlsManagement: false,
  };
}

export function selfHostedStatusToDraft(
  status: MobileRelayV2SelfHostedStatus,
): RelayV2SelfHostedDraft {
  if (!status.config) return createRelayV2SelfHostedDraft();
  return {
    enabled: status.config.enabled,
    brokerHostId: status.config.brokerHostId,
    issuerUrl: status.config.issuerUrl,
    listenHost: status.config.listenHost,
    listenPort: String(status.config.listenPort),
    tlsKeyPath: status.config.tlsKeyPath,
    tlsCertificatePath: status.config.tlsCertificatePath,
    tlsCaPath: status.config.tlsCaPath,
    externalTlsManagement: status.config.externalTlsManagement,
  };
}

export function validateRelayV2SelfHostedDraft(
  draft: RelayV2SelfHostedDraft,
): RelayV2SelfHostedValidation {
  const errors: RelayV2SelfHostedDraftErrors = {};
  if (!draft.enabled) {
    errors.enabled = "Enable the explicit self-hosted Relay v2 feature first.";
  }
  if (!draft.brokerHostId.trim()) {
    errors.brokerHostId = "Select the SSH devbox that will run Relay Center.";
  }

  const issuerUrl = draft.issuerUrl.trim();
  try {
    const parsed = new URL(issuerUrl);
    const authority = issuerUrl
      .slice(issuerUrl.indexOf("://") + 3)
      .split(/[/?#]/, 1)[0] ?? "";
    if (
      parsed.protocol !== "https:"
      || !parsed.hostname
      || parsed.port === "0"
      || parsed.username
      || parsed.password
      || authority.includes("@")
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      errors.issuerUrl =
        "Use a root https:// URL without credentials, path, query, or fragment.";
    }
  } catch {
    errors.issuerUrl = "Enter a valid HTTPS Relay URL.";
  }

  const listenHost = draft.listenHost.trim();
  const octets = listenHost.split(".");
  const validIpv4 = octets.length === 4 && octets.every((octet) => (
    /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255
  ));
  const values = validIpv4 ? octets.map(Number) : [];
  const privateIpv4 = validIpv4 && (
    values[0] === 10
    || (values[0] === 172 && values[1] >= 16 && values[1] <= 31)
    || (values[0] === 192 && values[1] === 168)
  );
  if (!privateIpv4 && listenHost !== "0.0.0.0") {
    errors.listenHost =
      "Enter the devbox private IPv4 address; use 0.0.0.0 only as an explicit all-interface opt-in.";
  }
  const listenPort = Number(draft.listenPort);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    errors.listenPort = "Port must be a whole number from 1 to 65535.";
  }
  if (!draft.externalTlsManagement) {
    if (!draft.tlsKeyPath.trim()) {
      errors.tlsKeyPath = "Select an owner-only 0600 TLS private key.";
    }
    if (!draft.tlsCertificatePath.trim()) {
      errors.tlsCertificatePath = "Select the owner-only 0600 TLS leaf certificate.";
    }
    if (!draft.tlsCaPath.trim()) {
      errors.tlsCaPath = "Select the owner-only 0600 CA certificate.";
    }
    const tlsPaths = [
      draft.tlsKeyPath.trim(),
      draft.tlsCertificatePath.trim(),
      draft.tlsCaPath.trim(),
    ].filter(Boolean);
    if (new Set(tlsPaths).size !== tlsPaths.length) {
      errors.tlsCaPath = "TLS key, leaf certificate, and CA must be distinct files.";
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors, value: null };
  }
  return {
    valid: true,
    errors,
    value: {
      enabled: true,
      brokerHostId: draft.brokerHostId.trim(),
      issuerUrl: new URL(issuerUrl).toString(),
      listenHost,
      listenPort,
      tlsKeyPath: draft.tlsKeyPath.trim(),
      tlsCertificatePath: draft.tlsCertificatePath.trim(),
      tlsCaPath: draft.tlsCaPath.trim(),
      externalTlsManagement: draft.externalTlsManagement,
    },
  };
}

export function relayV2SelfHostedDraftMatchesStatus(
  draft: RelayV2SelfHostedDraft,
  status: MobileRelayV2SelfHostedStatus | null,
): boolean {
  if (!status?.config) return false;
  const validation = validateRelayV2SelfHostedDraft(draft);
  if (!validation.valid) return false;
  const value = validation.value;
  const saved = status.config;
  return value.enabled === saved.enabled
    && value.brokerHostId === saved.brokerHostId
    && value.issuerUrl === saved.issuerUrl
    && value.listenHost === saved.listenHost
    && value.listenPort === saved.listenPort
    && value.tlsKeyPath === saved.tlsKeyPath
    && value.tlsCertificatePath === saved.tlsCertificatePath
    && value.tlsCaPath === saved.tlsCaPath
    && value.externalTlsManagement === saved.externalTlsManagement;
}

export function relayV2SelfHostedStatusLabel(
  status: MobileRelayV2SelfHostedStatus | null,
): string {
  if (!status) return "Not configured";
  if (status.error) return "Deployment check failed";
  if (status.centerStatus === "running") return "Relay Center running";
  if (status.bundleStatus === "ready" && status.tlsStatus === "ready") {
    return "Ready to start";
  }
  if (status.bundleStatus === "ready") return "Bundle deployed · TLS pending";
  if (status.configured) return "Configured · bundle pending";
  return "Not configured";
}

export function relayV2ExpiredBootstrapRotationAvailable(
  status: MobileRelayV2SelfHostedStatus | null,
): boolean {
  return status?.configured === true
    && status.hostBootstrapPending
    && !status.hostCredentialProvisioned;
}

/**
 * The v2 switch decision: the self-hosted config is the primary orchestration
 * stack only when it is enabled, provisioned, and clean (the Rust-side
 * `self_hosted_connector_prerequisites_are_complete` projection, mirrored as
 * `status.effective`). Otherwise the dashboard requires Relay v2 setup instead
 * of selecting another transport stack.
 */
export function relayV2StackEffective(
  status: MobileRelayV2SelfHostedStatus | null,
): boolean {
  return status?.effective === true;
}

export function relayV2SelfHostedConnectorDesiredRunning(
  status: MobileRelayV2SelfHostedStatus | null,
): boolean {
  return status?.connectorDesiredRunning === true;
}

export function relayV2SelfHostedStackLabel(
  status: MobileRelayV2SelfHostedStatus | null,
): string {
  return relayV2StackEffective(status)
    ? "Relay v2 self-hosted"
    : "Relay v2 setup required";
}
