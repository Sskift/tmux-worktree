import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRelayConnectionOverview,
  relayRepairRequiresManagementRestart,
  type RelayConnectionOverviewInput,
} from "../src/dashboard/Settings/relayConnectionOverviewModel.ts";
import type { RelayV2EnrollmentView } from "../src/dashboard/Settings/relayV2EnrollmentModel.ts";
import type { MobileRelayV2SelfHostedStatus } from "../src/platform/domainTypes.ts";

const configuredSelfHosted: MobileRelayV2SelfHostedStatus = {
  feature: "explicit_self_hosted",
  configured: true,
  config: {
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test/",
    listenHost: "10.0.0.1",
    listenPort: 8788,
    tlsKeyPath: "/private/tls.key",
    tlsCertificatePath: "/private/tls.crt",
    tlsCaPath: "/private/ca.pem",
    externalTlsManagement: false,
  },
  bundleStatus: "ready",
  tlsStatus: "ready",
  centerStatus: "running",
  hostBootstrapAvailable: true,
  hostBootstrapPending: false,
  hostCredentialProvisioned: true,
  profileProvisioned: true,
  connectorDesiredRunning: true,
  effective: true,
  bootstrapRotationPending: false,
  remoteTlsKeyPath: "~/.tmux-worktree/relay-v2-self-hosted/tls/tls.key",
  remoteTlsCertificatePath: "~/.tmux-worktree/relay-v2-self-hosted/tls/tls.crt",
  remoteTlsCaPath: "~/.tmux-worktree/relay-v2-self-hosted/tls/ca.pem",
  remoteProfilePath: "~/.tmux-worktree/relay-v2-self-hosted/deployment-profile-v1.json",
  remoteStateDirectory: "~/.tmux-worktree/relay-v2-self-hosted/state",
  error: null,
};

function readyEnrollmentView(
  overrides: Partial<RelayV2EnrollmentView> = {},
): RelayV2EnrollmentView {
  return {
    adapterAvailable: true,
    previewOnly: false,
    ready: true,
    missingCapabilities: [],
    readinessLabel: "Relay v2 connector ready for enrollment",
    readinessDetail: "The Mac host connector is registered with all six required capabilities.",
    v2CredentialLabel: "Relay v2 host credential ready",
    hostCredentialAction: "refresh",
    connectorAction: "stop",
    enrollmentAction: null,
    enrollmentActionDisabled: true,
    enrollmentActionLabel: "One-time enrollment active",
    error: null,
    review: null,
    qrArtifact: null,
    ...overrides,
  };
}

function input(overrides: Partial<RelayConnectionOverviewInput> = {}): RelayConnectionOverviewInput {
  return {
    selfHosted: configuredSelfHosted,
    enrollmentView: readyEnrollmentView(),
    connectedMobileDeviceCount: 0,
    inFlight: null,
    repairError: null,
    connectorStatus: "registered",
    ...overrides,
  };
}

test("not configured renders a neutral setup prompt", () => {
  const overview = deriveRelayConnectionOverview(input({ selfHosted: { ...configuredSelfHosted, configured: false } }));
  assert.equal(overview.tone, "neutral");
  assert.equal(overview.headline, "Relay is not set up");
  assert.equal(overview.primaryAction?.kind, "setup");
  assert.equal(overview.primaryAction?.label, "Set up relay…");
  assert.ok(overview.detail);
});

test("missing self-hosted status is treated as not configured", () => {
  const overview = deriveRelayConnectionOverview(input({ selfHosted: null }));
  assert.equal(overview.tone, "neutral");
  assert.equal(overview.primaryAction?.kind, "setup");
});

test("in-flight operation overrides the steady-state diagnosis with progress and no button", () => {
  const stalled = {
    ...configuredSelfHosted,
    bundleStatus: "missing" as const,
    centerStatus: "stopped" as const,
  };
  const overview = deriveRelayConnectionOverview(input({
    selfHosted: stalled,
    inFlight: { active: true, headline: "Starting relay center…" },
  }));
  assert.equal(overview.tone, "progress");
  assert.equal(overview.headline, "Starting relay center…");
  assert.equal(overview.primaryAction, null);
  assert.equal(overview.detail, null);
});

test("bundle not ready names the stalled piece", () => {
  const overview = deriveRelayConnectionOverview(input({
    selfHosted: { ...configuredSelfHosted, bundleStatus: "missing" },
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Relay server software is not ready");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("TLS not ready names the certificate", () => {
  const overview = deriveRelayConnectionOverview(input({
    selfHosted: { ...configuredSelfHosted, tlsStatus: "missing" },
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Relay server certificate is not ready");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("center stopped is a warning with a fix action", () => {
  const overview = deriveRelayConnectionOverview(input({
    selfHosted: { ...configuredSelfHosted, centerStatus: "stopped" },
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Relay center is not running");
  assert.equal(overview.primaryAction?.kind, "fix");
  assert.equal(overview.primaryAction?.label, "Fix connection");
});

test("backend unavailable surfaces as danger when the center is up", () => {
  const overview = deriveRelayConnectionOverview(input({
    enrollmentView: readyEnrollmentView({ adapterAvailable: false }),
  }));
  assert.equal(overview.tone, "danger");
  assert.equal(overview.headline, "Relay backend unavailable");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("repair rebuilds the management child after terminal connector failure", () => {
  for (const connectorStatus of ["failed", "superseded"] as const) {
    assert.equal(relayRepairRequiresManagementRestart({
      infraReady: true,
      adapterAvailable: true,
      connectorStatus,
    }), true);
  }
});

test("repair rebuilds a connector that remains in starting past its handshake deadline", () => {
  assert.equal(relayRepairRequiresManagementRestart({
    infraReady: true,
    adapterAvailable: true,
    connectorStatus: "starting",
    connectorStartingStalled: true,
  }), true);
});

test("repair reuses a healthy management child for ordinary stopped connectors", () => {
  assert.equal(relayRepairRequiresManagementRestart({
    infraReady: true,
    adapterAvailable: true,
    connectorStatus: "stopped",
  }), false);
});

test("repair starts the center when infrastructure or management is unavailable", () => {
  assert.equal(relayRepairRequiresManagementRestart({
    infraReady: false,
    adapterAvailable: true,
    connectorStatus: "stopped",
  }), true);
  assert.equal(relayRepairRequiresManagementRestart({
    infraReady: true,
    adapterAvailable: false,
    connectorStatus: "stopped",
  }), true);
});

test("a failed repair escalates the diagnosis to danger with the error in detail", () => {
  const overview = deriveRelayConnectionOverview(input({
    selfHosted: { ...configuredSelfHosted, centerStatus: "stopped" },
    repairError: "SSH connection to devbox failed.",
  }));
  assert.equal(overview.tone, "danger");
  assert.equal(overview.headline, "Relay center is not running");
  assert.equal(overview.detail, "SSH connection to devbox failed.");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("connector not registered is a warning with a fix action", () => {
  const overview = deriveRelayConnectionOverview(input({
    connectorStatus: "stopped",
    enrollmentView: readyEnrollmentView({ ready: false }),
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Not connected to the relay center");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("registered_incomplete identifies the incomplete Mac connector with no unsafe repair", () => {
  const overview = deriveRelayConnectionOverview(input({
    connectorStatus: "registered_incomplete",
    enrollmentView: readyEnrollmentView({
      ready: false,
      missingCapabilities: ["terminal.stream.resume.v1"],
    }),
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Mac connector is missing Relay v2 capabilities");
  assert.match(overview.detail ?? "", /Dashboard bundle/);
  assert.equal(overview.primaryAction, null);
});

test("registered_incomplete still names the stalled center when infra is down", () => {
  const overview = deriveRelayConnectionOverview(input({
    connectorStatus: "registered_incomplete",
    selfHosted: { ...configuredSelfHosted, centerStatus: "stopped" },
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Relay center is not running");
  assert.equal(overview.primaryAction?.kind, "fix");
});

test("registered connector is a success with show-QR action", () => {
  const overview = deriveRelayConnectionOverview(input());
  assert.equal(overview.tone, "success");
  assert.equal(overview.headline, "Mac connected — Relay v2 enrollment available");
  assert.equal(overview.primaryAction?.kind, "show_qr");
  assert.equal(overview.primaryAction?.label, "Show pairing QR");
  assert.match(overview.detail ?? "", /No mobile device is connected/i);
});

test("success reports the live mobile-device count", () => {
  const overview = deriveRelayConnectionOverview(input({ connectedMobileDeviceCount: 2 }));
  assert.equal(overview.tone, "success");
  assert.match(overview.detail ?? "", /2 mobile devices are connected/);
  assert.equal(overview.primaryAction?.kind, "show_qr");
});
