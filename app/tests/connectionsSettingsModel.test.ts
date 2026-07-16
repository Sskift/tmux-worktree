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
  deriveRelayV2EnrollmentView,
  relayV2EnrollmentReducer,
  type RelayV2EnrollmentReview,
  type RelayV2EnrollmentState,
} from "../src/dashboard/Settings/relayV2EnrollmentModel";
import {
  createFakeMobileRelayV2Adapter,
  createFakeMobileRelayV2State,
} from "../src/platform/relayV2FakeAdapter";

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

function readyRelayV2State(sharedSecretConfigured = true): RelayV2EnrollmentState {
  const initial = createFakeMobileRelayV2State(sharedSecretConfigured);
  return reduceRelayV2(initial, [
    {
      type: "v2CredentialReferenceObserved",
      credentialReference: "fake-preview://host-grant-reference",
    },
    { type: "hostRegistered", hostId: "mac-admin", connectorId: "connector-1" },
    {
      type: "capabilityIntersectionObserved",
      capabilities: RELAY_V2_REQUIRED_CAPABILITIES,
    },
  ]);
}

test("Relay v2 fake backend models host bootstrap, refresh, and authoritative registration", async () => {
  let nowMs = 1_000;
  const adapter = createFakeMobileRelayV2Adapter({ now: () => nowMs });

  const bootstrapped = await adapter.bootstrapHost();
  assert.equal(bootstrapped.hostCredential.status, "ready");
  assert.equal(
    bootstrapped.hostCredential.credentialReference,
    "fake-preview://relay-v2/host-grant",
  );
  const firstExpiry = bootstrapped.hostCredential.expiresAtMs;

  nowMs += 10_000;
  const refreshed = await adapter.refreshHost();
  assert.equal(refreshed.hostCredential.credentialReference, bootstrapped.hostCredential.credentialReference);
  assert.ok((refreshed.hostCredential.expiresAtMs ?? 0) > (firstExpiry ?? 0));

  const registered = await adapter.startConnector();
  assert.equal(registered.connector.acknowledgement, "host.registered");
  assert.equal(deriveRelayV2EnrollmentView(registered, nowMs).ready, true);
});

test("Relay v2 enrollment stays unavailable without host.registered or one required capability", async () => {
  const unregisteredState = createFakeMobileRelayV2State(true);
  const unregistered = deriveRelayV2EnrollmentView(unregisteredState, 1_000);

  assert.equal(unregistered.ready, false);
  assert.equal(unregistered.enrollmentActionDisabled, true);
  assert.equal(unregistered.qrPayload, null);
  assert.match(unregistered.readinessLabel, /not registered/i);
  assert.match(unregistered.readinessDetail, /host\.registered/);

  const missingTerminalResume = reduceRelayV2(createFakeMobileRelayV2State(true), [
    { type: "hostRegistered", hostId: "mac-admin", connectorId: "connector-1" },
    {
      type: "capabilityIntersectionObserved",
      capabilities: RELAY_V2_REQUIRED_CAPABILITIES.slice(0, -1),
    },
  ]);
  const incomplete = deriveRelayV2EnrollmentView(missingTerminalResume, 1_000);

  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missingCapabilities, ["terminal.stream.resume.v1"]);
  assert.equal(incomplete.enrollmentActionDisabled, true);
  assert.equal(incomplete.qrPayload, null);
  assert.match(incomplete.readinessDetail, /terminal\.stream\.resume\.v1/);

  const adapter = createFakeMobileRelayV2Adapter({ initialState: missingTerminalResume });
  await assert.rejects(
    adapter.createEnrollment({ intent: "create" }),
    /host\.registered and all six required capabilities/,
  );
  const afterRejectedCreate = await adapter.status();
  assert.deepEqual(afterRejectedCreate.enrollment, { status: "idle" });
  assert.strictEqual(afterRejectedCreate.v1Profile.sharedSecretConfigured, true);

  const markup = renderToStaticMarkup(createElement(RelayV2EnrollmentPreviewPanel, {
    state: missingTerminalResume,
    v1SharedSecretConfigured: true,
  }));
  assert.match(markup, /Relay v2 capabilities incomplete/);
  assert.match(markup, /<button[^>]*disabled=""/);
  assert.doesNotMatch(markup, /Relay v2 one-time enrollment preview QR code/);
});

test("Relay v2 readiness exposes only a one-time enrollment review and never claims the phone is online", () => {
  const readyState = reduceRelayV2(readyRelayV2State(), [
    { type: "enrollmentCreated", review: relayV2Review },
  ]);
  const ready = deriveRelayV2EnrollmentView(readyState, 1_000);

  assert.equal(ready.ready, true);
  assert.equal(ready.enrollmentActionDisabled, true);
  assert.equal(ready.v1CredentialLabel, "Relay v1 shared secret configured");
  assert.equal(ready.v2CredentialLabel, "Relay v2 host credential ready");
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

test("Relay v2 invalid active enrollment requires authoritative recovery without creating a second code", () => {
  const ready = readyRelayV2State(true);
  const activeState = (review: RelayV2EnrollmentReview): RelayV2EnrollmentState => ({
    ...ready,
    enrollment: { status: "active", review },
  });
  const invalidStates: Array<[string, RelayV2EnrollmentState]> = [
    ["issuer URL", activeState({
      ...relayV2Review,
      display: { ...relayV2Review.display, issuerUrl: "https://relay.test/path" },
    })],
    ["relay URL", activeState({
      ...relayV2Review,
      display: { ...relayV2Review.display, relayUrl: "wss://relay.test/client?token=leak" },
    })],
    ["enrollment ID", activeState({
      ...relayV2Review,
      enrollment: { ...relayV2Review.enrollment, enrollmentId: "" },
    })],
    ["enrollment code", activeState({
      ...relayV2Review,
      enrollment: { ...relayV2Review.enrollment, enrollmentCode: "not-an-enrollment-code" },
    })],
    ["review host binding", activeState({
      ...relayV2Review,
      display: { ...relayV2Review.display, hostId: "other-host" },
    })],
    ["connector host binding", {
      ...activeState(relayV2Review),
      connector: {
        status: "registered",
        acknowledgement: "host.registered",
        hostId: "other-host",
        connectorId: "connector-1",
        negotiatedCapabilityIntersection: RELAY_V2_REQUIRED_CAPABILITIES,
        exitCode: null,
        error: null,
        retryable: null,
      },
    }],
  ];

  for (const [label, state] of invalidStates) {
    const view = deriveRelayV2EnrollmentView(state, 1_000);
    assert.equal(view.ready, false, label);
    assert.equal(view.review, null, label);
    assert.equal(view.qrPayload, null, label);
    assert.equal(view.enrollmentAction, null, label);
    assert.equal(view.enrollmentActionDisabled, true, label);
    assert.doesNotMatch(view.enrollmentActionLabel, /active|retry|rebuild/i, label);
    assert.match(view.readinessDetail, /restore authoritative Relay v2 state/i, label);
    assert.equal(view.v1CredentialLabel, "Relay v1 shared secret configured", label);
  }
});

test("Relay v2 create retry is single-flight in UI state and backend create is idempotent", async () => {
  const readyState = readyRelayV2State();
  const creating = relayV2EnrollmentReducer(readyState, {
    type: "enrollmentCreateStarted",
    intent: "create",
  });
  const duplicateStart = relayV2EnrollmentReducer(creating, {
    type: "enrollmentCreateStarted",
    intent: "create",
  });
  assert.strictEqual(duplicateStart, creating);
  assert.equal(deriveRelayV2EnrollmentView(creating, 1_000).enrollmentActionDisabled, true);

  const failed = relayV2EnrollmentReducer(creating, {
    type: "enrollmentCreateFailed",
    error: "Temporary broker failure",
    retryable: true,
  });
  assert.equal(deriveRelayV2EnrollmentView(failed, 1_000).enrollmentAction, "retry");
  const retrying = relayV2EnrollmentReducer(failed, {
    type: "enrollmentCreateStarted",
    intent: "retry",
  });
  assert.deepEqual(retrying.enrollment, { status: "creating", intent: "retry" });

  const adapter = createFakeMobileRelayV2Adapter({
    initialState: readyState,
    hostId: "mac-admin",
    now: () => 10_000,
  });
  const first = await adapter.createEnrollment({ intent: "create" });
  const repeated = await adapter.createEnrollment({ intent: "retry" });
  assert.equal(first.enrollment.status, "active");
  assert.deepEqual(repeated.enrollment, first.enrollment);
});

test("Relay v2 expiry drops the code, rebuilds once, and known-grant revoke is idempotent", async () => {
  let nowMs = 1_000;
  const initial = {
    ...readyRelayV2State(),
    knownClientGrant: { status: "active" as const, grantId: "known-client-grant" },
  };
  const adapter = createFakeMobileRelayV2Adapter({
    initialState: initial,
    hostId: "mac-admin",
    now: () => nowMs,
  });
  const first = await adapter.createEnrollment({ intent: "create" });
  assert.equal(first.enrollment.status, "active");
  if (first.enrollment.status !== "active") return;
  const firstEnrollmentId = first.enrollment.review.enrollment.enrollmentId;

  nowMs = first.enrollment.review.enrollment.expiresAtMs;
  const expired = await adapter.status();
  assert.deepEqual(expired.enrollment, {
    status: "expired",
    enrollmentId: firstEnrollmentId,
    expiredAtMs: nowMs,
  });
  assert.doesNotMatch(JSON.stringify(expired), /twenroll2\./);

  const rebuilt = await adapter.createEnrollment({ intent: "rebuild" });
  assert.equal(rebuilt.enrollment.status, "active");
  if (rebuilt.enrollment.status !== "active") return;
  assert.notEqual(rebuilt.enrollment.review.enrollment.enrollmentId, firstEnrollmentId);

  const revoked = await adapter.revokeClientGrant({
    grantId: "known-client-grant",
    reason: "user_revoked",
  });
  const repeated = await adapter.revokeClientGrant({
    grantId: "known-client-grant",
    reason: "user_revoked",
  });
  assert.deepEqual(repeated.knownClientGrant, revoked.knownClientGrant);
  assert.equal(revoked.knownClientGrant.status, "revoked");
});

test("Relay v2 non-retryable failures preserve v1 and offer reconfiguration, not Retry", () => {
  const readyState = readyRelayV2State();
  const v1Profile = readyState.v1Profile;
  const hostCredential = readyState.hostCredential;
  const failed = relayV2EnrollmentReducer(readyState, {
    type: "enrollmentCreateFailed",
    error: "Broker rejected the enrollment attempt.",
  });
  const view = deriveRelayV2EnrollmentView(failed, 1_000);

  assert.strictEqual(failed.v1Profile, v1Profile);
  assert.strictEqual(failed.hostCredential, hostCredential);
  assert.equal(failed.v1Profile.sharedSecretConfigured, true);
  assert.equal(failed.hostCredential.credentialReference, "fake-preview://host-grant-reference");
  assert.equal(view.enrollmentAction, null);
  assert.match(view.enrollmentActionLabel, /reconfigure Relay v2/i);
  assert.equal(view.qrPayload, null);
  assert.match(view.error ?? "", /Relay v1 remains unchanged; no fallback was attempted/);

  const markup = renderToStaticMarkup(createElement(RelayV2EnrollmentPreviewPanel, {
    state: failed,
    v1SharedSecretConfigured: true,
  }));
  assert.doesNotMatch(markup, />Retry enrollment</);
  assert.match(markup, /Enrollment failed — reconfigure Relay v2/);
});

test("Relay v2 contradictory registered observations fail closed", async () => {
  const contradictory = {
    ...readyRelayV2State(),
    connector: {
      status: "registered" as const,
      acknowledgement: "host.registered" as const,
      hostId: "",
      connectorId: "connector-1",
      negotiatedCapabilityIntersection: RELAY_V2_REQUIRED_CAPABILITIES,
      exitCode: null,
      error: null,
      retryable: null,
    },
  };
  const view = deriveRelayV2EnrollmentView(contradictory, 1_000);

  assert.equal(view.ready, false);
  assert.equal(view.enrollmentActionDisabled, true);
  assert.equal(view.qrPayload, null);
  assert.match(view.readinessDetail, /restore authoritative Relay v2 state/i);

  const adapter = createFakeMobileRelayV2Adapter({ initialState: contradictory });
  await assert.rejects(
    adapter.createEnrollment({ intent: "create" }),
    /restore authoritative Relay v2 state/i,
  );
});

test("Relay v2 SUPERSEDED is terminal for that connector process and hides enrollment readiness", () => {
  const active = reduceRelayV2(readyRelayV2State(true), [
    { type: "enrollmentCreated", review: relayV2Review },
  ]);
  const superseded = relayV2EnrollmentReducer(active, {
    type: "connectorSuperseded",
  });
  const view = deriveRelayV2EnrollmentView(superseded, 1_000);

  assert.equal(superseded.connector.status, "superseded");
  assert.equal(superseded.connector.exitCode, 78);
  assert.equal(view.ready, false);
  assert.equal(view.qrPayload, null);
  assert.equal(superseded.v1Profile.sharedSecretConfigured, true);
});

test("Relay v2 renderer state and QR omit bootstrap, access, refresh, and v1 secret values", () => {
  const activeState = reduceRelayV2(readyRelayV2State(true), [
    { type: "enrollmentCreated", review: relayV2Review },
  ]);
  const serializedState = JSON.stringify(activeState);
  for (const forbidden of [
    "bootstrapToken",
    "bootstrapSecret",
    "accessToken",
    "refreshToken",
    "legacy-secret-value",
  ]) assert.doesNotMatch(serializedState, new RegExp(forbidden, "i"));

  const payload = deriveRelayV2EnrollmentView(activeState, 1_000).qrPayload;
  assert.ok(payload);
  const qr = new URL(payload);
  assert.deepEqual([...qr.searchParams.keys()], [
    "v",
    "issuerUrl",
    "relayUrl",
    "hostId",
    "enrollmentId",
    "enrollmentCode",
  ]);
  assert.equal(qr.searchParams.has("accessToken"), false);
  assert.equal(qr.searchParams.has("refreshToken"), false);
});
