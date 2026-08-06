import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRelayConnectionOverview,
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
    v1CredentialLabel: "Relay v1 shared secret configured",
    v2CredentialLabel: "Relay v2 host credential ready",
    hostCredentialAction: "refresh",
    connectorAction: "stop",
    enrollmentAction: null,
    enrollmentActionDisabled: true,
    enrollmentActionLabel: "One-time enrollment active",
    grantRevokeDisabled: false,
    grantRevokeLabel: "Revoke known client grant",
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
    knownGrantActive: false,
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

test("registered_incomplete warns the phone app needs an update with no fix action", () => {
  const overview = deriveRelayConnectionOverview(input({
    connectorStatus: "registered_incomplete",
    enrollmentView: readyEnrollmentView({
      ready: false,
      missingCapabilities: ["terminal.stream.resume.v1"],
    }),
  }));
  assert.equal(overview.tone, "warning");
  assert.equal(overview.headline, "Phone app needs an update");
  assert.match(overview.detail ?? "", /missing required features/);
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
  assert.equal(overview.headline, "Connected — ready to pair a phone");
  assert.equal(overview.primaryAction?.kind, "show_qr");
  assert.equal(overview.primaryAction?.label, "Show pairing QR");
  assert.equal(overview.detail, null);
});

test("success mentions an already-paired phone", () => {
  const overview = deriveRelayConnectionOverview(input({ knownGrantActive: true }));
  assert.equal(overview.tone, "success");
  assert.match(overview.detail ?? "", /1 phone already paired/);
  assert.equal(overview.primaryAction?.kind, "show_qr");
});
