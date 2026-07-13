import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MOBILE_RELAY_HIDDEN_REFRESH_MS,
  MOBILE_RELAY_VISIBLE_REFRESH_MS,
  buildMobileRelayV1PairingPayload,
  createMobileRelayAsyncCoordinator,
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

function activateOwner(
  coordinator: ReturnType<typeof createMobileRelayAsyncCoordinator>,
  owner: object,
) {
  coordinator.commit(owner);
  const activation = coordinator.activate();
  const lease = coordinator.capture(owner);
  assert.ok(lease);
  return { activation, lease };
}

function commitOwner(
  coordinator: ReturnType<typeof createMobileRelayAsyncCoordinator>,
  owner: object,
) {
  const ownerCommit = coordinator.commit(owner);
  const lease = coordinator.capture(owner);
  assert.ok(lease);
  assert.strictEqual(ownerCommit.lease, lease);
  return lease;
}

test("mobile relay keeps the shared secret out of generated adb commands", () => {
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useMobileRelayController.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /buildMobileRelayLaunchCommand|adb shell|copyLaunch/);
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
    relayUrl: "wss://relay.example.test:0",
    hostId: "mac-admin",
    secret: "token",
  }), null);
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.test",
    hostId: "mac-admin",
    secret: "a".repeat(4_096),
  }), null);
  assert.equal(buildMobileRelayV1PairingPayload({
    relayUrl: "wss://relay.example.test",
    hostId: "mac/admin",
    secret: "token",
  }), null);
  for (const relayUrl of [
    "wss://@relay.example.test",
    "wss://relay.example.test?",
    "wss://relay.example.test#",
  ]) {
    assert.equal(buildMobileRelayV1PairingPayload({
      relayUrl,
      hostId: "mac-admin",
      secret: "token",
    }), null);
  }
  assert.equal(
    buildMobileRelayV1PairingPayload({
      relayUrl: "WSS://RELAY.EXAMPLE.TEST/",
      hostId: "mac-admin",
      secret: "token",
    }),
    "tmuxworktree://pair?relayUrl=wss%3A%2F%2Frelay.example.test&token=token&hostId=mac-admin",
  );
});

test("mobile relay derived status follows operation and connection priority", () => {
  assert.deepEqual(deriveMobileRelayViewState(idleViewState), {
    busy: false,
    indicatorStatus: "stopped",
    statusText: "Connector stopped",
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
    statusText: "Connector retrying",
    tokenState: "Configured",
    buttonActive: true,
  });

  assert.equal(deriveMobileRelayViewState({
    ...idleViewState,
    active: true,
    connected: true,
  }).statusText, "Connector connected");
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
  }).statusText, "Deploying broker");
});

test("mobile relay keeps its visibility-aware polling cadence", () => {
  assert.equal(MOBILE_RELAY_VISIBLE_REFRESH_MS, 2_000);
  assert.equal(MOBILE_RELAY_HIDDEN_REFRESH_MS, 15_000);
});

test("an initial Relay response preserves every draft field edited while it was pending", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const { lease: owner } = activateOwner(coordinator, {});
  const initialStatus = coordinator.issueStatusRequest(owner, "untouched");
  assert.ok(initialStatus);

  coordinator.markDraftEdited(owner, "relayUrl");
  coordinator.markDraftEdited(owner, "brokerHostId");
  coordinator.markDraftEdited(owner, "hostId");
  coordinator.markDraftEdited(owner, "secret");

  assert.equal(coordinator.isCurrentStatusRequest(initialStatus), true);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "relayUrl"), false);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "brokerHostId"), false);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "hostId"), false);
  assert.equal(coordinator.acceptDraftSync(initialStatus, "secret"), false);
});

test("a submitted Relay response only normalizes fields unchanged since submission", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const { lease: owner } = activateOwner(coordinator, {});
  coordinator.markDraftEdited(owner, "relayUrl");
  coordinator.markDraftEdited(owner, "brokerHostId");
  coordinator.markDraftEdited(owner, "hostId");
  coordinator.markDraftEdited(owner, "secret");
  const submitted = coordinator.issueStatusRequest(owner, "submitted");
  assert.ok(submitted);

  coordinator.markDraftEdited(owner, "secret");

  assert.equal(coordinator.acceptDraftSync(submitted, "relayUrl"), true);
  assert.equal(coordinator.acceptDraftSync(submitted, "brokerHostId"), true);
  assert.equal(coordinator.acceptDraftSync(submitted, "hostId"), true);
  assert.equal(coordinator.acceptDraftSync(submitted, "secret"), false);

  const laterPoll = coordinator.issueStatusRequest(owner, "untouched");
  assert.ok(laterPoll);
  assert.equal(coordinator.acceptDraftSync(laterPoll, "relayUrl"), true);
  assert.equal(coordinator.acceptDraftSync(laterPoll, "hostId"), true);
  assert.equal(coordinator.acceptDraftSync(laterPoll, "secret"), false);
});

test("one-click broker setup force-syncs generated URL, token, and selected Relay center", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const { lease: owner } = activateOwner(coordinator, {});
  for (const field of ["relayUrl", "brokerHostId", "hostId", "secret"] as const) {
    coordinator.markDraftEdited(owner, field);
  }
  const brokerStarted = coordinator.issueStatusRequest(owner, "brokerStarted");
  assert.ok(brokerStarted);

  assert.equal(coordinator.acceptDraftSync(brokerStarted, "relayUrl"), true);
  assert.equal(coordinator.acceptDraftSync(brokerStarted, "brokerHostId"), true);
  assert.equal(coordinator.acceptDraftSync(brokerStarted, "hostId"), false);
  assert.equal(coordinator.acceptDraftSync(brokerStarted, "secret"), true);
});

test("newer Relay reads and mutations reject stale live-status publications", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const { lease: owner } = activateOwner(coordinator, {});
  const initialRead = coordinator.issueStatusRequest(owner);
  const newerRead = coordinator.issueStatusRequest(owner);
  assert.ok(initialRead);
  assert.ok(newerRead);

  assert.equal(coordinator.isCurrentStatusRequest(initialRead), false);
  assert.equal(coordinator.isCurrentStatusRequest(newerRead), true);
  assert.equal(coordinator.acceptDraftSync(initialRead, "relayUrl"), false);

  const operation = coordinator.beginOperation(owner);
  assert.ok(operation);
  assert.equal(coordinator.isCurrentStatusRequest(newerRead), false);
  assert.equal(coordinator.isCurrentOperation(operation), true);
  assert.equal(coordinator.hasActiveOperation(owner), true);

  assert.equal(coordinator.finishOperation(operation), true);
  assert.equal(coordinator.hasActiveOperation(owner), false);
});

test("a speculative owner B render cannot invalidate committed owner A", async () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backendA = {};
  const backendB = {};
  const { lease: ownerA } = activateOwner(coordinator, backendA);
  const requestA = coordinator.issueStatusRequest(ownerA);
  assert.ok(requestA);

  let resolveA = (_value: string) => {};
  const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
  const publications: string[] = [];
  const pendingA = responseA.then((value) => {
    if (
      coordinator.isCurrent(ownerA)
      && coordinator.isCurrentStatusRequest(requestA)
    ) publications.push(value);
  });

  assert.equal(coordinator.capture(backendB), null);
  assert.equal(coordinator.isCurrent(ownerA), true);
  assert.equal(coordinator.isCurrentStatusRequest(requestA), true);

  resolveA("A-current");
  await pendingA;
  assert.deepEqual(publications, ["A-current"]);
});

test("committing owner B fences late owner A status before B publishes", async () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backendA = {};
  const backendB = {};
  const { lease: ownerA } = activateOwner(coordinator, backendA);
  const requestA = coordinator.issueStatusRequest(ownerA);
  assert.ok(requestA);

  let resolveA = (_value: string) => {};
  const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
  const publications: string[] = [];
  const pendingA = responseA.then((value) => {
    if (
      coordinator.isCurrent(ownerA)
      && coordinator.isCurrentStatusRequest(requestA)
    ) publications.push(value);
  });

  const ownerB = commitOwner(coordinator, backendB);
  const requestB = coordinator.issueStatusRequest(ownerB);
  assert.ok(requestB);
  assert.equal(coordinator.isCurrent(ownerA), false);
  assert.equal(coordinator.isCurrentStatusRequest(requestA), false);
  assert.equal(coordinator.markDraftEdited(ownerA, "secret"), false);
  assert.equal(coordinator.issueStatusRequest(ownerA), null);

  resolveA("A-late");
  await pendingA;
  assert.deepEqual(publications, []);
  assert.equal(coordinator.isCurrent(ownerB), true);
  assert.equal(coordinator.isCurrentStatusRequest(requestB), true);

  const ownerA2 = commitOwner(coordinator, backendA);
  assert.notEqual(ownerA2.epoch, ownerA.epoch);
  assert.equal(coordinator.isCurrent(ownerA), false);
});

test("owner A operation finally cannot clear owner B operation", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backendA = {};
  const backendB = {};
  const { lease: ownerA } = activateOwner(coordinator, backendA);
  const operationA = coordinator.beginOperation(ownerA);
  assert.ok(operationA);
  assert.equal(coordinator.hasActiveOperation(ownerA), true);

  assert.equal(coordinator.capture(backendB), null);
  assert.equal(coordinator.hasActiveOperation(ownerA), true);

  const ownerB = commitOwner(coordinator, backendB);
  const operationB = coordinator.beginOperation(ownerB);
  assert.ok(operationB);
  assert.equal(coordinator.isCurrentOperation(operationA), false);
  assert.equal(coordinator.finishOperation(operationA), false);
  assert.equal(coordinator.hasActiveOperation(ownerB), true);
  assert.equal(coordinator.isCurrentOperation(operationB), true);

  assert.equal(coordinator.finishOperation(operationB), true);
  assert.equal(coordinator.hasActiveOperation(ownerB), false);
});

test("owner switch after save continuation prevents the old backend start mutation", async () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backendA = {};
  const backendB = {};
  const { lease: ownerA } = activateOwner(coordinator, backendA);
  const operationA = coordinator.beginOperation(ownerA);
  assert.ok(operationA);

  let resolveSave = () => {};
  const deferredSave = new Promise<void>((resolve) => { resolveSave = resolve; });
  let oldBackendStartCalls = 0;
  const startAfterSave = (async () => {
    await deferredSave;
    if (!coordinator.isCurrentOperation(operationA)) return false;
    oldBackendStartCalls += 1;
    return true;
  })();

  resolveSave();
  const ownerB = commitOwner(coordinator, backendB);
  assert.equal(await startAfterSave, false);
  assert.equal(oldBackendStartCalls, 0);
  assert.equal(coordinator.isCurrent(ownerB), true);
});

test("exact lifecycle cleanup invalidates old work without deactivating a replay", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backend = {};
  const first = activateOwner(coordinator, backend);
  const firstRequest = coordinator.issueStatusRequest(first.lease);
  assert.ok(firstRequest);

  const secondActivation = coordinator.activate();
  const secondLease = coordinator.capture(backend);
  assert.ok(secondLease);
  assert.equal(coordinator.deactivate(first.activation), false);
  assert.equal(coordinator.isCurrent(secondLease), true);
  assert.equal(coordinator.deactivate(secondActivation), true);
  assert.equal(coordinator.capture(backend), null);
  assert.equal(coordinator.isCurrentStatusRequest(firstRequest), false);
});

test("activation replay clears an old busy operation without resetting drafts", () => {
  const coordinator = createMobileRelayAsyncCoordinator();
  const backend = {};
  const first = activateOwner(coordinator, backend);
  assert.equal(coordinator.markDraftEdited(first.lease, "secret"), true);
  const oldOperation = coordinator.beginOperation(first.lease);
  assert.ok(oldOperation);
  assert.equal(coordinator.hasActiveOperation(first.lease), true);

  const secondActivation = coordinator.activate();
  const secondLease = coordinator.capture(backend);
  assert.ok(secondLease);
  assert.equal(coordinator.isCurrentOperation(oldOperation), false);
  assert.equal(coordinator.hasActiveOperation(secondLease), false);
  assert.equal(coordinator.deactivate(first.activation), false);

  const replayStatus = coordinator.issueStatusRequest(secondLease, "untouched");
  assert.ok(replayStatus);
  assert.equal(coordinator.acceptDraftSync(replayStatus, "secret"), false);

  const replayOperation = coordinator.beginOperation(secondLease);
  assert.ok(replayOperation);
  assert.equal(coordinator.hasActiveOperation(secondLease), true);
  assert.equal(coordinator.finishOperation(replayOperation), true);
  assert.equal(coordinator.deactivate(secondActivation), true);
});

test("mobile relay exposes unknown and failed status instead of pretending to be stopped", () => {
  const source = readFileSync(
    new URL("../src/dashboard/hooks/useMobileRelayController.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /ownerLease = asyncCoordinator\.capture\(dashboardBackend\)/);
  assert.doesNotMatch(source, /renderOwner/);
  assert.equal(source.match(/useLayoutEffect\(\(\) => \{/g)?.length, 2);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s*committedBackendRef\.current = dashboardBackend;\s*const ownerCommit = asyncCoordinator\.commit\(dashboardBackend\);/,
  );
  assert.match(
    source,
    /const activation = asyncCoordinator\.activate\(\);[\s\S]*return \(\) => \{\s*asyncCoordinator\.deactivate\(activation\);\s*\};/,
  );
  assert.match(source, /statusKnown: true/);
  assert.match(source, /statusKnown: false/);
  assert.match(source, /Unable to read Relay status/);
  assert.match(source, /const requireKnownStatus = useCallback/);
  assert.match(source, /if \(!requireKnownStatus\(\)\) return false;/);
  assert.match(source, /Wait for Relay status before changing its configuration/);
  assert.match(
    source,
    /const saved = await saveConfig\(operation\);[\s\S]*?if \(!saved\.secret\.trim\(\)\)[\s\S]*?if \(!asyncCoordinator\.isCurrentOperation\(operation\)\) return false;\s*await dashboardBackend\.relay\.start\(\);/,
  );
  const startBrokerStart = source.indexOf("const startBroker = useCallback");
  const startBrokerEnd = source.indexOf("const stop = useCallback", startBrokerStart);
  const startBrokerBlock = source.slice(startBrokerStart, startBrokerEnd);
  assert.match(startBrokerBlock, /relay\.startBroker\(/);
  assert.match(startBrokerBlock, /quickTunnel: true/);
  assert.match(startBrokerBlock, /issueStatusRequest\(ownerLease, "brokerStarted"\)/);
  assert.match(startBrokerBlock, /relay\.start\(\)/);
  assert.match(startBrokerBlock, /checkStatus\(operation\)/);
  assert.match(source, /if \(!asyncCoordinator\.finishOperation\(operation\)\) return;/);
  assert.doesNotMatch(source, /finally\s*\{[\s\S]{0,120}set(?:Loading|Saving|BrokerStarting|Stopping)\(false\)/);
  assert.doesNotMatch(source, /function fallbackMobileRelayStatus/);
});
