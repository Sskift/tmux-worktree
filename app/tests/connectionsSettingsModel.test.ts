import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateHostRemovalImpact,
  createEmptyHostDraft,
  hostConfigToDraft,
  sshCandidateToDraft,
  summarizeRelayStatus,
  validateHostDraft,
  validateRelayDraft,
} from "../src/dashboard/Settings/connectionsModel";

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
      label: "Checking Relay",
      detail: "Reading the saved configuration and current Relay process state.",
      tone: "progress",
    },
  );
  assert.deepEqual(
    summarizeRelayStatus({ connectionState: "stopped", active: false, connected: false }),
    {
      label: "Stopped",
      detail: "Relay is configured locally and is not accepting connections.",
      tone: "neutral",
    },
  );
  assert.equal(summarizeRelayStatus({ connectionState: "starting", active: true, connected: false }).label, "Starting");
  assert.equal(summarizeRelayStatus({ connectionState: "connected", active: true, connected: true }).label, "Connected");
  assert.equal(summarizeRelayStatus({ connectionState: "retrying", active: true, connected: false }).label, "Retrying");
  assert.deepEqual(
    summarizeRelayStatus({ connectionState: "error", active: false, connected: false, error: "TLS rejected" }),
    { label: "Error", detail: "TLS rejected", tone: "danger" },
  );
});

test("Relay validation applies action-specific token and broker requirements", () => {
  const draft = {
    relayUrl: "wss://relay.example.com",
    brokerHostId: "",
    hostId: "mac-admin",
    token: "",
  };

  assert.equal(validateRelayDraft(draft, "save").valid, true);
  const start = validateRelayDraft(draft, "start");
  assert.equal(start.valid, false);
  assert.match(start.errors.token ?? "", /required/);
  const broker = validateRelayDraft(draft, "startBroker");
  assert.equal(broker.valid, false);
  assert.match(broker.errors.brokerHostId ?? "", /broker host/);
});

test("Relay validation rejects non-websocket URLs", () => {
  const result = validateRelayDraft({
    relayUrl: "https://relay.example.com",
    brokerHostId: "remote",
    hostId: "mac-admin",
    token: "secret",
  }, "start");

  assert.equal(result.valid, false);
  assert.match(result.errors.relayUrl ?? "", /ws:\/\/ or wss:\/\//);
});
