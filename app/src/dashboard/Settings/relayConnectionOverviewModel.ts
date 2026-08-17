import type {
  MobileRelayV2Connector,
  MobileRelayV2SelfHostedStatus,
} from "../../platform/domainTypes";
import type { RelayV2EnrollmentView } from "./relayV2EnrollmentModel";

export type RelayConnectionOverviewTone =
  | "success"
  | "progress"
  | "warning"
  | "danger"
  | "neutral";

export type RelayConnectionOverviewPrimaryAction =
  | { kind: "show_qr"; label: string }
  | { kind: "fix"; label: string }
  | { kind: "setup"; label: string };

export type RelayConnectionOverview = {
  tone: RelayConnectionOverviewTone;
  /** One sentence describing the Mac/Relay state, never inferred phone reachability. */
  headline: string;
  /** At most one short supporting sentence. */
  detail: string | null;
  primaryAction: RelayConnectionOverviewPrimaryAction | null;
};

export type RelayConnectionOverviewInput = {
  selfHosted: MobileRelayV2SelfHostedStatus | null;
  /** Derived v2 enrollment view, or null before the status poll has loaded. */
  enrollmentView: RelayV2EnrollmentView | null;
  connectedMobileDeviceCount: number;
  inFlight: { active: boolean; headline: string } | null;
  repairError: string | null;
  /** Normalized connector status; distinguishes registered_incomplete. */
  connectorStatus: MobileRelayV2Connector["status"];
};

/**
 * Shared self-hosted infra readiness predicate. Both the diagnosis and
 * runConnectionRepair must use this so the center/bundle/TLS check can never
 * diverge between "what the card says" and "what repair does".
 */
export function selfHostedInfraReady(
  selfHosted: MobileRelayV2SelfHostedStatus | null,
): { ready: boolean; centerReady: boolean; bundleReady: boolean; tlsReady: boolean } {
  const centerReady =
    selfHosted?.centerStatus === "running" || selfHosted?.centerStatus === "ready";
  const bundleReady = selfHosted?.bundleStatus === "ready";
  const tlsReady = selfHosted?.tlsStatus === "ready";
  return {
    ready: centerReady && bundleReady && tlsReady,
    centerReady,
    bundleReady,
    tlsReady,
  };
}

/**
 * A failed/superseded connector is terminal inside its current management
 * child. Retrying start_connector against that same child cannot recover it;
 * repair must rebuild the management child through startCenter instead.
 */
export function relayRepairRequiresManagementRestart(input: {
  infraReady: boolean;
  adapterAvailable: boolean | undefined;
  connectorStatus: MobileRelayV2Connector["status"];
  connectorStartingStalled?: boolean;
}): boolean {
  return !input.infraReady
    || input.adapterAvailable === false
    || input.connectorStartingStalled === true
    || input.connectorStatus === "failed"
    || input.connectorStatus === "superseded";
}

/**
 * Reduces the full Relay state to a single glance: "what should I do right now".
 *
 * State mapping (in effective priority order):
 *  1. v2 not configured            → neutral, "Relay is not set up" (setup opens Advanced)
 *  2. in-flight operation          → progress, no button ("Starting relay center…" etc.)
 *  3. center/bundle/TLS not ready  → warning naming the stalled piece (fix)
 *  4. management backend down      → danger "Relay backend unavailable" (fix)
 *  5. connector registered_incomplete → warning naming the incomplete Mac connector
 *  6. connector not registered     → warning "Not connected to the relay center" (fix)
 *  7. connector registered         → success "Mac connected — enrollment available" (show QR)
 *
 * A failed repair escalates the current diagnosis to danger and carries the
 * error one-liner in `detail`.
 */
export function deriveRelayConnectionOverview(
  input: RelayConnectionOverviewInput,
): RelayConnectionOverview {
  const {
    selfHosted,
    enrollmentView,
    connectedMobileDeviceCount,
    inFlight,
    repairError,
    connectorStatus,
  } = input;

  if (!selfHosted?.configured) {
    return {
      tone: "neutral",
      headline: "Relay is not set up",
      detail: "Set up a relay center on one of your SSH hosts, then pair your phone.",
      primaryAction: { kind: "setup", label: "Set up relay…" },
    };
  }

  if (inFlight?.active) {
    return {
      tone: "progress",
      headline: inFlight.headline,
      detail: null,
      primaryAction: null,
    };
  }

  const { ready: infraReady, bundleReady, tlsReady } = selfHostedInfraReady(selfHosted);
  const backendUnavailable = enrollmentView?.adapterAvailable === false;

  let tone: RelayConnectionOverviewTone;
  let headline: string;
  let detail: string | null;
  let primaryAction: RelayConnectionOverviewPrimaryAction | null;

  if (!infraReady) {
    tone = "warning";
    headline = !bundleReady
      ? "Relay server software is not ready"
      : !tlsReady
        ? "Relay server certificate is not ready"
        : "Relay center is not running";
    detail = "Fix connection will start the relay center.";
    primaryAction = { kind: "fix", label: "Fix connection" };
  } else if (backendUnavailable) {
    tone = "danger";
    headline = "Relay backend unavailable";
    detail = "The relay management service is not responding.";
    primaryAction = { kind: "fix", label: "Fix connection" };
  } else if (connectorStatus === "registered_incomplete") {
    tone = "warning";
    headline = "Mac connector is missing Relay v2 capabilities";
    detail = "Update the Dashboard bundle on this Mac, then restart the connector.";
    primaryAction = null;
  } else if (enrollmentView?.ready !== true) {
    tone = "warning";
    headline = "Not connected to the relay center";
    detail = "Fix connection will restart the relay connection.";
    primaryAction = { kind: "fix", label: "Fix connection" };
  } else {
    tone = "success";
    headline = "Mac connected — Relay v2 enrollment available";
    detail = connectedMobileDeviceCount > 0
      ? `${connectedMobileDeviceCount} mobile ${connectedMobileDeviceCount === 1 ? "device is" : "devices are"} connected through Relay v2.`
      : "No mobile device is connected. Use the pairing QR to connect one.";
    primaryAction = { kind: "show_qr", label: "Show pairing QR" };
  }

  if (repairError) {
    return {
      tone: "danger",
      headline,
      detail: repairError,
      primaryAction,
    };
  }

  return { tone, headline, detail, primaryAction };
}
