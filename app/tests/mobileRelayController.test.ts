import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MOBILE_RELAY_HIDDEN_REFRESH_MS,
  MOBILE_RELAY_VISIBLE_REFRESH_MS,
  buildMobileRelayLaunchCommand,
  buildMobileRelayV1PairingPayload,
  createMobileRelayAsyncCoordinator,
  deriveMobileRelayViewState,
  quoteAdbShellArgument,
  shellSingleQuote,
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
      relayUrl: "wss://relay.example.test",
      hostId: "mac-admin",
      secret: "relay-token",
    }),
    [
      "adb shell am start -n com.tmuxworktree.mobile/.V2Activity",
      `  --es relayUrl "'wss://relay.example.test'"`,
      `  --es hostId "'mac-admin'"`,
      `  --es relaySecret "'relay-token'"`,
    ].join(" \\\n"),
  );

  assert.match(
    buildMobileRelayLaunchCommand({
      relayUrl: "wss://relay.example.test/client",
      hostId: "mac-admin",
      secret: "",
    }),
    /--es relaySecret "'<TW_RELAY_SECRET>'"/,
  );
  assert.equal(shellSingleQuote("value'with'quotes"), "'value'\"'\"'with'\"'\"'quotes'");
  const hostileValue = "token'; printf PWNED; '";
  const androidShellWord = execFileSync(
    "/bin/sh",
    ["-c", `printf %s ${quoteAdbShellArgument(hostileValue)}`],
    { encoding: "utf8" },
  );
  assert.equal(androidShellWord, shellSingleQuote(hostileValue));
  assert.equal(
    execFileSync("/bin/sh", ["-c", `printf %s ${androidShellWord}`], { encoding: "utf8" }),
    hostileValue,
  );
  assert.doesNotMatch(
    buildMobileRelayLaunchCommand({
      relayUrl: "wss://relay.example.test/client",
      hostId: "mac-admin",
      secret: "token'; echo pwned; '",
    }),
    /--ez autoConnect|\.MainActivity/,
  );
});

test("mobile relay builds an explicit WSS-only Relay v1 profile payload", () => {
  assert.equal(
    buildMobileRelayV1PairingPayload({
      relayUrl: " wss://relay.example.test ",
      hostId: " mac-admin ",
      secret: " token value ",
    }),
    "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.test&token=token%20value&hostId=mac-admin",
  );
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "ws://relay.example.test",
    hostId: "mac-admin",
    secret: "token",
  }), null);
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "wss://user:password@relay.example.test",
    hostId: "mac-admin",
    secret: "token",
  }), null);
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.test/client",
    hostId: "mac-admin",
    secret: "token",
  }), null);
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.test",
    hostId: "mac/admin",
    secret: "token",
  }), null);
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

test("an initial Relay response preserves every draft field edited while it was pending", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const initialStatus = coordinator.issueStatusRequest("untouched");

  coordinator.markDraftEdited("relayUrl");
  coordinator.markDraftEdited("hostId");
  coordinator.markDraftEdited("secret");

  assert.equal(coordinator.isCurrentStatusRequest(initialStatus), true);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "relayUrl"), false);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "hostId"), false);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "secret"), false);
});

test("a submitted Relay response only normalizes fields unchanged since submission", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  coordinator.markDraftEdited("relayUrl");
  coordinator.markDraftEdited("hostId");
  coordinator.markDraftEdited("secret");
  const submitted = coordinator.issueStatusRequest("submitted");

  coordinator.markDraftEdited("secret");

  assert.equal(coordinator.acceptDraftSync(submitted, "relayUrl"), true);
  assert.equal(coordinator.acceptDraftSync(submitted, "hostId"), true);
  assert.equal(coordinator.acceptDraftSync(submitted, "secret"), false);

  const laterPoll = coordinator.issueStatusRequest("untouched");
  assert.equal(coordinator.acceptDraftSync(laterPoll, "relayUrl"), true);
  assert.equal(coordinator.acceptDraftSync(laterPoll, "hostId"), true);
  assert.equal(coordinator.acceptDraftSync(laterPoll, "secret"), false);
});

test("newer Relay reads and mutations reject stale live-status publications", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const initialRead = coordinator.issueStatusRequest();
  const newerRead = coordinator.issueStatusRequest();

  assert.equal(coordinator.isCurrentStatusRequest(initialRead), false);
  assert.equal(coordinator.isCurrentStatusRequest(newerRead), true);
  assert.equal(coordinator.acceptDraftSync(initialRead, "relayUrl"), false);

  const operation = coordinator.beginOperation();
  assert.equal(coordinator.isCurrentStatusRequest(newerRead), false);
  assert.equal(coordinator.isCurrentOperation(operation), true);
  assert.equal(coordinator.hasActiveOperation(), true);

  coordinator.finishOperation(operation);
  assert.equal(coordinator.hasActiveOperation(), false);
});

test("mobile relay exposes unknown and failed status instead of pretending to be stopped", () => {
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useMobileRelayController.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /const \[statusKnown, setStatusKnown\] = useState\(false\)/);
  assert.match(source, /setStatusKnown\(true\)/);
  assert.match(source, /setStatusKnown\(false\)/);
  assert.match(source, /Unable to read Relay status/);
  assert.match(source, /const requireKnownStatus = useCallback/);
  assert.match(source, /if \(!requireKnownStatus\(\)\) return false;/);
  assert.match(source, /Wait for Relay status before changing its configuration/);
  assert.doesNotMatch(source, /function fallbackMobileRelayStatus/);
});
