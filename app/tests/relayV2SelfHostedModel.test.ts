import assert from "node:assert/strict";
import test from "node:test";
import {
  createRelayV2SelfHostedDraft,
  relayV2ExpiredBootstrapRotationAvailable,
  relayV2SelfHostedStatusLabel,
  relayV2SelfHostedDraftMatchesStatus,
  selfHostedStatusToDraft,
  validateRelayV2SelfHostedDraft,
} from "../src/dashboard/Settings/relayV2SelfHostedModel.ts";
import type { MobileRelayV2SelfHostedStatus } from "../src/platform/domainTypes.ts";

const configuredStatus: MobileRelayV2SelfHostedStatus = {
  feature: "explicit_self_hosted",
  configured: true,
  config: {
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test/",
    listenHost: "0.0.0.0",
    listenPort: 8788,
    tlsKeyPath: "/private/tls.key",
    tlsCertificatePath: "/private/tls.crt",
    tlsCaPath: "/private/ca.pem",
    externalTlsManagement: false,
  },
  bundleStatus: "ready",
  tlsStatus: "ready",
  centerStatus: "stopped",
  hostBootstrapAvailable: false,
  hostBootstrapPending: false,
  hostCredentialProvisioned: false,
  bootstrapRotationPending: false,
  remoteTlsKeyPath: "~/.tmux-worktree/relay-v2-self-hosted/tls/tls.key",
  remoteTlsCertificatePath: "~/.tmux-worktree/relay-v2-self-hosted/tls/tls.crt",
  remoteTlsCaPath: "~/.tmux-worktree/relay-v2-self-hosted/tls/ca.pem",
  remoteProfilePath: "~/.tmux-worktree/relay-v2-self-hosted/deployment-profile-v1.json",
  remoteStateDirectory: "~/.tmux-worktree/relay-v2-self-hosted/state",
  error: null,
};

test("self-hosted Relay v2 draft is explicit and normalizes a root HTTPS origin", () => {
  const draft = {
    ...createRelayV2SelfHostedDraft(),
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test",
    listenHost: "10.20.30.40",
    tlsKeyPath: "/private/tls.key",
    tlsCertificatePath: "/private/tls.crt",
    tlsCaPath: "/private/ca.pem",
  };
  assert.deepEqual(validateRelayV2SelfHostedDraft(draft), {
    valid: true,
    errors: {},
    value: {
      enabled: true,
      brokerHostId: "devbox",
      issuerUrl: "https://relay.company.test/",
      listenHost: "10.20.30.40",
      listenPort: 8788,
      tlsKeyPath: "/private/tls.key",
      tlsCertificatePath: "/private/tls.crt",
      tlsCaPath: "/private/ca.pem",
      externalTlsManagement: false,
    },
  });
});

test("external TLS management skips local TLS file requirements", () => {
  const validation = validateRelayV2SelfHostedDraft({
    ...createRelayV2SelfHostedDraft(),
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test/",
    listenHost: "10.20.30.40",
    externalTlsManagement: true,
  });
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, {});
  assert.equal(validation.value?.externalTlsManagement, true);
});

test("external TLS round-trips through the draft status mapping", () => {
  const externalStatus: MobileRelayV2SelfHostedStatus = {
    ...configuredStatus,
    config: {
      ...configuredStatus.config!,
      externalTlsManagement: true,
      tlsKeyPath: "",
      tlsCertificatePath: "",
      tlsCaPath: "",
    },
  };
  const draft = selfHostedStatusToDraft(externalStatus);
  assert.equal(draft.externalTlsManagement, true);
  assert.equal(relayV2SelfHostedDraftMatchesStatus(draft, externalStatus), true);
  assert.equal(
    relayV2SelfHostedDraftMatchesStatus(
      { ...draft, externalTlsManagement: false },
      externalStatus,
    ),
    false,
  );
});

test("expired Host bootstrap rotation is limited to version-zero pending state", () => {
  const pending = {
    ...configuredStatus,
    centerStatus: "running" as const,
    hostBootstrapAvailable: true,
    hostBootstrapPending: true,
    hostCredentialProvisioned: false,
  };
  assert.equal(relayV2ExpiredBootstrapRotationAvailable(pending), true);
  assert.equal(
    relayV2ExpiredBootstrapRotationAvailable({
      ...pending,
      hostBootstrapPending: false,
      hostCredentialProvisioned: true,
    }),
    false,
  );
});

test("self-hosted Relay v2 rejects implicit activation and secret-bearing URLs", () => {
  for (const issuerUrl of [
    "http://relay.company.test/",
    "https://user@relay.company.test/",
    "https://relay.company.test/v2",
    "https://relay.company.test/?token=forbidden",
  ]) {
    const validation = validateRelayV2SelfHostedDraft({
      ...createRelayV2SelfHostedDraft(),
      brokerHostId: "devbox",
      issuerUrl,
      tlsKeyPath: "/private/tls.key",
      tlsCertificatePath: "/private/tls.crt",
      tlsCaPath: "/private/ca.pem",
    });
    assert.equal(validation.valid, false, issuerUrl);
    assert.ok(validation.errors.enabled, issuerUrl);
    assert.ok(validation.errors.issuerUrl, issuerUrl);
  }
});

test("self-hosted Relay v2 requires an explicit private IPv4 bind address", () => {
  assert.equal(createRelayV2SelfHostedDraft().listenHost, "");
  for (const listenHost of [
    "",
    "relay.internal",
    "203.0.113.8",
    "2001:db8::1",
  ]) {
    const validation = validateRelayV2SelfHostedDraft({
      ...createRelayV2SelfHostedDraft(),
      enabled: true,
      brokerHostId: "devbox",
      issuerUrl: "https://relay.company.test/",
      listenHost,
      tlsKeyPath: "/private/tls.key",
      tlsCertificatePath: "/private/tls.crt",
      tlsCaPath: "/private/ca.pem",
    });
    assert.equal(validation.valid, false, listenHost);
    assert.match(validation.errors.listenHost ?? "", /private IPv4/);
  }

  for (const listenHost of ["10.2.3.4", "172.16.5.6", "192.168.1.8", "0.0.0.0"]) {
    const validation = validateRelayV2SelfHostedDraft({
      ...createRelayV2SelfHostedDraft(),
      enabled: true,
      brokerHostId: "devbox",
      issuerUrl: "https://relay.company.test/",
      listenHost,
      tlsKeyPath: "/private/tls.key",
      tlsCertificatePath: "/private/tls.crt",
      tlsCaPath: "/private/ca.pem",
    });
    assert.equal(validation.valid, true, listenHost);
  }
});

test("self-hosted Relay v2 requires a CA input distinct from the Broker leaf", () => {
  const validation = validateRelayV2SelfHostedDraft({
    ...createRelayV2SelfHostedDraft(),
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test/",
    tlsKeyPath: "/private/tls.key",
    tlsCertificatePath: "/private/tls.crt",
    tlsCaPath: "/private/tls.crt",
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.tlsCaPath ?? "", /distinct/);
});

test("persisted self-hosted inputs restore without implying Host or Android readiness", () => {
  assert.deepEqual(selfHostedStatusToDraft(configuredStatus), {
    enabled: true,
    brokerHostId: "devbox",
    issuerUrl: "https://relay.company.test/",
    listenHost: "0.0.0.0",
    listenPort: "8788",
    tlsKeyPath: "/private/tls.key",
    tlsCertificatePath: "/private/tls.crt",
    tlsCaPath: "/private/ca.pem",
    externalTlsManagement: false,
  });
  assert.equal(
    relayV2SelfHostedDraftMatchesStatus(
      selfHostedStatusToDraft(configuredStatus),
      configuredStatus,
    ),
    true,
  );
  assert.equal(
    relayV2SelfHostedDraftMatchesStatus(
      { ...selfHostedStatusToDraft(configuredStatus), listenPort: "9443" },
      configuredStatus,
    ),
    false,
  );
  assert.equal(relayV2SelfHostedStatusLabel(configuredStatus), "Ready to start");
  assert.equal(
    relayV2SelfHostedStatusLabel({
      ...configuredStatus,
      centerStatus: "running",
      hostBootstrapAvailable: true,
    }),
    "Relay Center running",
  );
});
