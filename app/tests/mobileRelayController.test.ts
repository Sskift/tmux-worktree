import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_RELAY_HIDDEN_REFRESH_MS,
  MOBILE_RELAY_VISIBLE_REFRESH_MS,
  buildMobileRelayLaunchCommand,
  deriveMobileRelayViewState,
} from "../src/dashboard/hooks/useMobileRelayController.ts";

const idleViewState = {
  active: false,
  connected: false,
  connectionState: "stopped",
  secret: "",
  popoverOpen: false,
  loading: false,
  saving: false,
  brokerStarting: false,
  stopping: false,
};

test("mobile relay launch command preserves configured and placeholder token forms", () => {
  assert.equal(
    buildMobileRelayLaunchCommand({
      relayUrl: "wss://relay.example.test/client",
      hostId: "mac-admin",
      secret: "relay-token",
    }),
    [
      "adb shell am start -n com.tmuxworktree.mobile/.MainActivity",
      "  --es relayUrl 'wss://relay.example.test/client'",
      "  --es hostId 'mac-admin'",
      "  --es relaySecret 'relay-token'",
      "  --ez autoConnect true",
    ].join(" \\\n"),
  );

  assert.match(
    buildMobileRelayLaunchCommand({
      relayUrl: "wss://relay.example.test/client",
      hostId: "mac-admin",
      secret: "",
    }),
    /--es relaySecret '<TW_RELAY_SECRET>'/,
  );
});

test("mobile relay derived status follows operation and connection priority", () => {
  assert.deepEqual(deriveMobileRelayViewState(idleViewState), {
    busy: false,
    indicatorStatus: "stopped",
    statusText: "Stopped",
    tokenState: "Missing",
    buttonActive: false,
  });

  assert.deepEqual(deriveMobileRelayViewState({
    ...idleViewState,
    active: true,
    connectionState: "retrying",
    secret: "configured",
  }), {
    busy: false,
    indicatorStatus: "starting",
    statusText: "Reconnecting",
    tokenState: "Configured",
    buttonActive: true,
  });

  assert.equal(deriveMobileRelayViewState({
    ...idleViewState,
    active: true,
    connected: true,
  }).statusText, "Connected");
  assert.equal(deriveMobileRelayViewState({
    ...idleViewState,
    active: true,
    connected: true,
    saving: true,
  }).statusText, "Saving");
  assert.equal(deriveMobileRelayViewState({
    ...idleViewState,
    loading: true,
    brokerStarting: true,
    stopping: true,
  }).statusText, "Starting broker");
});

test("mobile relay keeps its visibility-aware polling cadence", () => {
  assert.equal(MOBILE_RELAY_VISIBLE_REFRESH_MS, 2_000);
  assert.equal(MOBILE_RELAY_HIDDEN_REFRESH_MS, 15_000);
});
