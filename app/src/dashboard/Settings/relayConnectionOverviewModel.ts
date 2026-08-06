import type { MobileRelayV2SelfHostedStatus } from "../../platform/domainTypes";
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
  /** One sentence: "Connected — ready to pair a phone" etc. */
  headline: string;
  /** At most one short supporting sentence. */
  detail: string | null;
  primaryAction: RelayConnectionOverviewPrimaryAction | null;
};

export type RelayConnectionOverviewInput = {
  selfHosted: MobileRelayV2SelfHostedStatus | null;
  /** Derived v2 enrollment view, or null before the status poll has loaded. */
  enrollmentView: RelayV2EnrollmentView | null;
  knownGrantActive: boolean;
  inFlight: { active: boolean; headline: string } | null;
  repairError: string | null;
};

/**
 * Reduces the full Relay state to a single glance: "what should I do right now".
 *
 * State mapping (in effective priority order):
 *  1. v2 not configured            → neutral, "Relay is not set up" (setup opens Advanced)
 *  2. in-flight operation          → progress, no button ("Starting relay center…" etc.)
 *  3. center/bundle/TLS not ready  → warning naming the stalled piece (fix)
 *  4. management backend down      → danger "Relay backend unavailable" (fix)
 *  5. connector not registered     → warning "Not connected to the relay center" (fix)
 *  6. connector registered         → success "Connected — ready to pair a phone" (show QR)
 *
 * A failed repair escalates the current diagnosis to danger and carries the
 * error one-liner in `detail`.
 */
export function deriveRelayConnectionOverview(
  input: RelayConnectionOverviewInput,
): RelayConnectionOverview {
  const { selfHosted, enrollmentView, knownGrantActive, inFlight, repairError } = input;

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

  const centerReady =
    selfHosted.centerStatus === "running" || selfHosted.centerStatus === "ready";
  const bundleReady = selfHosted.bundleStatus === "ready";
  const tlsReady = selfHosted.tlsStatus === "ready";
  const backendUnavailable = enrollmentView?.adapterAvailable === false;

  let tone: RelayConnectionOverviewTone;
  let headline: string;
  let detail: string | null;
  let primaryAction: RelayConnectionOverviewPrimaryAction;

  if (!centerReady || !bundleReady || !tlsReady) {
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
  } else if (enrollmentView?.ready !== true) {
    tone = "warning";
    headline = "Not connected to the relay center";
    detail = "Fix connection will restart the relay connection.";
    primaryAction = { kind: "fix", label: "Fix connection" };
  } else {
    tone = "success";
    headline = "Connected — ready to pair a phone";
    detail = knownGrantActive
      ? "1 phone already paired. You can pair another phone at any time."
      : null;
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
