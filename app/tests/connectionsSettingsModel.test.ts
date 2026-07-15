import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RelayV2EnrollmentPreviewPanel } from "../src/dashboard/Settings/RelayV2EnrollmentPreviewPanel";
import {
  calculateHostRemovalImpact,
  createEmptyHostDraft,
  hostConfigToDraft,
  sshCandidateToDraft,
  summarizeRelayStatus,
  validateHostDraft,
  validateRelayDraft,
} from "../src/dashboard/Settings/connectionsModel";
import {
  RELAY_V2_REQUIRED_CAPABILITIES,
  createRelayV2EnrollmentState,
  deriveRelayV2EnrollmentView,
  relayV2EnrollmentReducer,
  type RelayV2EnrollmentReview,
  type RelayV2EnrollmentState,
} from "../src/dashboard/Settings/relayV2EnrollmentModel";

const relayV2Review: RelayV2EnrollmentReview = {
  enrollment: {
    enrollmentId: "enrollment-preview",
    enrollmentCode: "twenroll2.one-time-preview-code",
    expiresAtMs: 4_000_000_000_000,
  },
  display: {
    issuerUrl: "https://relay.test",
    relayUrl: "wss://relay.test/client",
    hostId: "mac-admin",
    deviceLabel: "Pixel preview",
  },
};

function reduceRelayV2(
  initial: RelayV2EnrollmentState,
  events: Parameters<typeof relayV2EnrollmentReducer>[1][],
): RelayV2EnrollmentState {
  return events.reduce(relayV2EnrollmentReducer, initial);
}

test("the existing Relay v1 UI receives no v2 preview markup without explicit fake state", () => {
  const markup = renderToStaticMarkup(createElement(RelayV2EnrollmentPreviewPanel, {
    state: undefined,
    v1SharedSecretConfigured: true,
  }));

  assert.equal(markup, "");
});

test("host draft normalization keeps every supported connection field", () => {
  const draft = hostConfigToDraft({
    id: "build-mac",
    label: "Build Mac",
    host: "build.example.com",
    user: "builder",
    port: 2202,
    identityFile: "~/.ssh/build",
    worktreeBase: "~/worktrees",
    tmuxPath: "/opt/homebrew/bin/tmux",
    twPath: "~/.local/bin/tw",
  });

  const result = validateHostDraft(draft);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.value, {
    id: "build-mac",
    label: "Build Mac",
    host: "build.example.com",
    user: "builder",
    port: 2202,
    identityFile: "~/.ssh/build",
    worktreeBase: "~/worktrees",
    tmuxPath: "/opt/homebrew/bin/tmux",
    twPath: "~/.local/bin/tw",
  });
});

test("optional host values normalize to omissions instead of empty strings", () => {
  const draft = {
    ...createEmptyHostDraft(),
    id: "devbox",
    label: "Dev box",
    host: "devbox.local",
    port: "22",
    user: "   ",
  };
  const result = validateHostDraft(draft);

  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.value, {
    id: "devbox",
    label: "Dev box",
    host: "devbox.local",
    port: 22,
  });
});

test("host validation rejects bad ports, duplicate IDs, and edit-time identity changes", () => {
  const duplicate = validateHostDraft({
    ...createEmptyHostDraft(),
    id: "prod",
    label: "Production",
    host: "prod.internal",
    port: "70000",
  }, { existingHosts: [{ id: "prod" }] });

  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.errors.id, "Host ID “prod” already exists.");
  assert.match(duplicate.errors.port ?? "", /1 to 65535/);

  const changedIdentity = validateHostDraft({
    ...createEmptyHostDraft(),
    id: "renamed",
    label: "Production",
    host: "prod.internal",
  }, { editingHostId: "prod", existingHosts: [{ id: "prod" }] });

  assert.equal(changedIdentity.valid, false);
  assert.match(changedIdentity.errors.id ?? "", /cannot be changed/);
});

test("SSH candidates produce stable IDs and preserve connection fields", () => {
  const draft = sshCandidateToDraft({
    id: "Build Mac.local",
    label: "Build Mac",
    host: "10.0.0.8",
    user: "builder",
    identityFile: "~/.ssh/build",
  });

  assert.equal(draft.id, "build-mac-local");
  assert.equal(draft.host, "10.0.0.8");
  assert.equal(draft.user, "builder");
  assert.equal(draft.identityFile, "~/.ssh/build");
});

test("host removal impact counts only matching remote sessions and terminals", () => {
  const impact = calculateHostRemovalImpact(
    "remote-1",
    [{ hostId: "remote-1" }, { hostId: null }, { hostId: "remote-1" }, { hostId: "remote-2" }],
    [{ hostId: "remote-2" }, { hostId: "remote-1" }],
  );

  assert.deepEqual(impact, { sessions: 2, terminals: 1, total: 3 });
});

test("Relay summary distinguishes stopped, starting, connected, retrying, and error", () => {
  assert.deepEqual(
    summarizeRelayStatus({
      statusKnown: false,
      connectionState: "stopped",
      active: false,
      connected: false,
    }),
    {
      label: "Checking Mac connector",
      detail: "Reading the saved connector configuration and local process state.",
      tone: "progress",
    },
  );
  assert.deepEqual(
    summarizeRelayStatus({ connectionState: "stopped", active: false, connected: false }),
    {
      label: "Mac connector stopped",
      detail: "The Mac connector is stopped. A previously deployed Relay center keeps running independently.",
      tone: "neutral",
    },
  );
  assert.equal(summarizeRelayStatus({ connectionState: "starting", active: true, connected: false }).label, "Starting Mac connector");
  assert.equal(summarizeRelayStatus({ connectionState: "connected", active: true, connected: true }).label, "Mac connector connected");
  assert.equal(summarizeRelayStatus({ connectionState: "retrying", active: true, connected: false }).label, "Mac connector retrying");
  assert.doesNotMatch(
    summarizeRelayStatus({ connectionState: "connected", active: true, connected: true }).detail,
    /mobile client can reach/i,
  );
  assert.deepEqual(
    summarizeRelayStatus({ connectionState: "error", active: false, connected: false, error: "TLS rejected" }),
    { label: "Mac connector error", detail: "TLS rejected", tone: "danger" },
  );
});

test("Relay validation applies action-specific token and broker requirements", () => {
  const draft = {
    relayUrl: "wss://relay.company.test",
    brokerHostId: "devbox",
    hostId: "mac-admin",
    token: "",
  };

  assert.equal(validateRelayDraft(draft, "save").valid, true);
  const start = validateRelayDraft(draft, "start");
  assert.equal(start.valid, false);
  assert.match(start.errors.token ?? "", /required/);
  assert.equal(validateRelayDraft(draft, "startBroker").valid, true);
  const broker = validateRelayDraft({
    relayUrl: "",
    brokerHostId: "",
    hostId: "",
    token: "",
  }, "startBroker");
  assert.equal(broker.valid, false);
  assert.match(broker.errors.brokerHostId ?? "", /Relay center/);

  assert.equal(validateRelayDraft({
    relayUrl: "",
    brokerHostId: "devbox",
    hostId: "",
    token: "",
  }, "startBroker").valid, true);
});

test("Relay validation requires trusted WSS or an explicit loopback diagnostic URL", () => {
  const result = validateRelayDraft({
    relayUrl: "https://relay.company.test",
    brokerHostId: "remote",
    hostId: "mac-admin",
    token: "secret",
  }, "start");

  assert.equal(result.valid, false);
  assert.match(result.errors.relayUrl ?? "", /trusted wss/);

  for (const relayUrl of [
    "wss://relay.example.com",
    "wss://relay.example.com/",
    "ws://desk-mac.local:8787",
    "ws://10.0.0.8:8787",
    "wss://user@relay.company.test",
    "wss://@relay.company.test",
    "wss://relay.company.test:0",
    "wss://relay.company.test/client",
  ]) {
    assert.equal(validateRelayDraft({
      relayUrl,
      brokerHostId: "remote",
      hostId: "mac-admin",
      token: "secret",
    }, "start").valid, false, relayUrl);
  }

  assert.equal(validateRelayDraft({
    relayUrl: "ws://127.0.0.1:8787",
    brokerHostId: "remote",
    hostId: "mac-admin",
    token: "secret",
  }, "start").valid, true);
});

test("Relay v2 enrollment stays visibly unavailable without host registration or one required capability", () => {
  const unregistered = deriveRelayV2EnrollmentView(
    createRelayV2EnrollmentState(true),
    1_000,
  );

  assert.equal(unregistered.ready, false);
  assert.equal(unregistered.enrollmentActionDisabled, true);
  assert.equal(unregistered.qrPayload, null);
  assert.match(unregistered.readinessLabel, /not registered/i);
  assert.match(unregistered.readinessDetail, /host\.registered/);

  const missingTerminalResume = reduceRelayV2(createRelayV2EnrollmentState(true), [
    { type: "hostRegistered", hostId: "mac-admin", connectorId: "connector-1" },
    {
      type: "capabilityIntersectionObserved",
      capabilities: RELAY_V2_REQUIRED_CAPABILITIES.slice(0, -1),
    },
    { type: "enrollmentCreated", review: relayV2Review },
  ]);
  const incomplete = deriveRelayV2EnrollmentView(missingTerminalResume, 1_000);

  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missingCapabilities, ["terminal.stream.resume.v1"]);
  assert.equal(incomplete.enrollmentActionDisabled, true);
  assert.equal(incomplete.review, null);
  assert.equal(incomplete.qrPayload, null);
  assert.match(incomplete.readinessDetail, /terminal\.stream\.resume\.v1/);

  const markup = renderToStaticMarkup(createElement(RelayV2EnrollmentPreviewPanel, {
    state: missingTerminalResume,
    v1SharedSecretConfigured: true,
  }));
  assert.match(markup, /Relay v2 capabilities incomplete/);
  assert.match(markup, /<button[^>]*disabled=""/);
  assert.doesNotMatch(markup, /Relay v2 one-time enrollment preview QR code/);
});

test("Relay v2 readiness exposes only a one-time enrollment review and never claims the phone is online", () => {
  const readyState = reduceRelayV2(createRelayV2EnrollmentState(true), [
    {
      type: "v2CredentialReferenceObserved",
      credentialReference: "host-grant-reference",
    },
    { type: "hostRegistered", hostId: "mac-admin", connectorId: "connector-1" },
    {
      type: "capabilityIntersectionObserved",
      capabilities: RELAY_V2_REQUIRED_CAPABILITIES,
    },
    { type: "enrollmentCreated", review: relayV2Review },
  ]);
  const ready = deriveRelayV2EnrollmentView(readyState, 1_000);

  assert.equal(ready.ready, true);
  assert.equal(ready.enrollmentActionDisabled, false);
  assert.equal(ready.v1CredentialLabel, "Relay v1 shared secret configured");
  assert.equal(ready.v2CredentialLabel, "Relay v2 credential reference available");
  assert.match(ready.readinessDetail, /Phone connectivity is not verified/);
  assert.doesNotMatch(ready.readinessDetail, /phone is online/i);
  assert.ok(ready.qrPayload);

  const qr = new URL(ready.qrPayload);
  assert.equal(qr.protocol, "tmuxworktree:");
  assert.equal(qr.hostname, "enroll");
  assert.deepEqual([...qr.searchParams.keys()], [
    "v",
    "issuerUrl",
    "relayUrl",
    "hostId",
    "enrollmentId",
    "enrollmentCode",
  ]);
  assert.equal(qr.searchParams.get("enrollmentCode"), relayV2Review.enrollment.enrollmentCode);
  assert.equal(qr.searchParams.has("accessToken"), false);
  assert.equal(qr.searchParams.has("refreshToken"), false);

  const markup = renderToStaticMarkup(createElement(RelayV2EnrollmentPreviewPanel, {
    state: readyState,
    v1SharedSecretConfigured: true,
  }));
  assert.match(markup, /Relay v2 connector ready for enrollment/);
  assert.match(markup, /Fake-backed preview only/);
  assert.match(markup, /Relay v2 one-time enrollment preview QR code/);
});

test("Relay v2 failure is isolated from both the v1 shared secret and v2 credential reference", () => {
  const readyState = reduceRelayV2(createRelayV2EnrollmentState(true), [
    {
      type: "v2CredentialReferenceObserved",
      credentialReference: "host-grant-reference",
    },
    { type: "hostRegistered", hostId: "mac-admin", connectorId: "connector-1" },
    {
      type: "capabilityIntersectionObserved",
      capabilities: RELAY_V2_REQUIRED_CAPABILITIES,
    },
  ]);
  const v1Profile = readyState.v1Profile;
  const v2Credential = readyState.v2Credential;
  const failed = relayV2EnrollmentReducer(readyState, {
    type: "enrollmentCreateFailed",
    error: "Broker rejected the enrollment attempt.",
  });
  const view = deriveRelayV2EnrollmentView(failed, 1_000);

  assert.strictEqual(failed.v1Profile, v1Profile);
  assert.strictEqual(failed.v2Credential, v2Credential);
  assert.equal(failed.v1Profile.sharedSecretConfigured, true);
  assert.equal(failed.v2Credential.credentialReference, "host-grant-reference");
  assert.equal(view.enrollmentActionDisabled, true);
  assert.equal(view.qrPayload, null);
  assert.match(view.error ?? "", /Relay v1 remains unchanged; no fallback was attempted/);
});
