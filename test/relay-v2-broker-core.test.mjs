import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const broker = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");

const HOST_ID = "mac-admin";
const NOW_MS = 1_783_700_000_000;

function authContext(role, overrides = {}) {
  return {
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: role === "host" ? "host-jti" : "client-jti",
    kid: "key-2026-07",
    expiresAtMs: NOW_MS + 3_600_000,
    authorizationRevision: "1",
    authorizationFence: "authorization-fence-1",
    ...overrides,
  };
}

function carrierBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function hostHello({
  hostId = HOST_ID,
  requestId = randomUUID(),
  hostEpoch = randomUUID(),
  hostInstanceId = randomUUID(),
  capabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  clientDialects = ["tw-relay.v1", "tw-relay.v2"],
  maxFrameBytes = 1_048_576,
  terminalMaxFrameBytes = Math.min(65_536, maxFrameBytes),
} = {}) {
  return {
    carrierVersion: 1,
    type: "host.hello",
    requestId,
    payload: {
      hostId,
      hostEpoch,
      hostInstanceId,
      clientDialects,
      capabilities,
      limits: {
        maxFrameBytes,
        terminalMaxFrameBytes,
      },
    },
  };
}

async function registerHost(
  core,
  transportId,
  hello = hostHello(),
  authOverrides = {},
  connectionIncarnation = randomUUID(),
) {
  const hostId = hello.payload.hostId;
  const directoryBefore = core.inspectHost(hostId);
  core.attachHostCarrier(transportId, authContext("host", {
    hostId,
    jti: `${transportId}-jti`,
    ...authOverrides,
  }), connectionIncarnation);
  const result = await core.receiveHostFrame(transportId, carrierBytes(hello));
  assert.equal(result.accepted, true);
  const registration = result.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(registration);
  const directoryPending = core.inspectHost(hostId);
  assert.equal(
    directoryPending?.connectorId,
    directoryBefore?.connectorId,
    "registered delivery is not committed yet",
  );
  assert.equal(directoryPending?.revision, directoryBefore?.revision);
  const committed = core.acknowledgeHostControlDelivery(transportId, registration.deliveryId);
  assert.equal(committed.accepted, true);
  return {
    hello,
    result: { ...result, actions: [...result.actions, ...committed.actions] },
    registration,
    connectorId: registration.frame.connectorId,
    connectionIncarnation,
  };
}

async function openRoute(
  core,
  transportId,
  connectionId = randomUUID(),
  openedMaxFrameBytes = 1_048_576,
  hostId = HOST_ID,
  authOverrides = {},
) {
  const opened = core.openClientRoute(connectionId, authContext("client", {
    hostId,
    jti: `${connectionId}-jti`,
    ...authOverrides,
  }));
  assert.equal(opened.accepted, true);
  const deliveries = core.drainHostCarrier(transportId, { maxFrames: 1 });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].frame.type, "route.open");
  assert.equal(core.acknowledgeHostDelivery(transportId, deliveries[0].deliveryId).accepted, true);
  const routeOpen = deliveries[0].frame;
  const acknowledged = await core.receiveHostFrame(transportId, carrierBytes({
    carrierVersion: 1,
    type: "route.opened",
    requestId: routeOpen.requestId,
    connectorId: routeOpen.connectorId,
    routeId: routeOpen.routeId,
    routeFence: routeOpen.routeFence,
    payload: {
      acceptedAtMs: NOW_MS,
      maxFrameBytes: openedMaxFrameBytes,
    },
  }));
  assert.equal(acknowledged.accepted, true);
  assert.equal(acknowledged.actions[0].kind, "route_opened");
  return { connectionId, routeOpen, acknowledged };
}

function publicBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}

function clientHello(requestId = randomUUID(), overrides = {}) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "client.hello",
    requestId,
    hostId: HOST_ID,
    payload: {
      clientInstanceId: "android-install",
      capabilities: [],
      requiredCapabilities: [],
      resume: null,
    },
    ...overrides,
  };
}

function hostsSnapshotGet(requestId = randomUUID()) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "hosts.snapshot.get",
    requestId,
    payload: {},
  };
}

function commandExecute(requestId, commandId, hostEpoch) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "command.execute",
    requestId,
    commandId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: "scope-local",
    sessionId: "session-opaque",
    payload: {
      dedupeWindowId: "dedupe-window",
      operation: "send_agent_message",
      arguments: { pane: 0, message: "continue", submit: true },
    },
  };
}

function clientTerminalAck(streamId = "stream-1") {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.output_ack",
    streamId,
    payload: { generation: "generation-1", nextOffset: "0" },
  };
}

function clientSweepCapacityFrame() {
  return publicBytes({
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input",
    streamId: "sweep-capacity",
    payload: {
      generation: "generation-1",
      inputSeq: "1",
      encoding: "base64",
      data: Buffer.alloc(241).toString("base64"),
    },
  });
}

function clientTerminalInputBytesOfSize(targetBytes, index) {
  const makeFrame = (generation, data) => ({
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input",
    streamId: `s-${index}`,
    payload: {
      generation,
      inputSeq: String(index + 1),
      encoding: "base64",
      data,
    },
  });
  const baselineData = Buffer.alloc(3).toString("base64");
  const baseline = publicBytes(makeFrame("g", baselineData));
  const fixedBytes = baseline.byteLength - 1 - baselineData.length;
  for (let generationBytes = 1; generationBytes <= 128; generationBytes += 1) {
    const dataBase64Bytes = targetBytes - fixedBytes - generationBytes;
    if (dataBase64Bytes <= 0 || dataBase64Bytes % 4 !== 0) continue;
    const decodedBytes = dataBase64Bytes / 4 * 3;
    if (decodedBytes > 65_536) continue;
    const bytes = publicBytes(makeFrame(
      "g".repeat(generationBytes),
      Buffer.alloc(decodedBytes).toString("base64"),
    ));
    if (bytes.byteLength === targetBytes) return bytes;
  }
  throw new Error(`cannot construct ${targetBytes}-byte public frame`);
}

function hostTerminalAck(streamId = "stream-1") {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId,
    payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
  };
}

function hostRouteData(identity, seq = "1", frame = hostTerminalAck()) {
  return {
    carrierVersion: 1,
    type: "route.data",
    connectorId: identity.connectorId,
    routeId: identity.routeId,
    routeFence: identity.routeFence,
    direction: "host_to_client",
    seq,
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicBytes(frame)).toString("base64"),
    },
  };
}

test("Relay v2 Upgrade dispatch isolates credential and dialect stacks without fallback", async () => {
  let legacyCalls = 0;
  let v2Calls = 0;
  const dependencies = {
    verifyLegacySecret(secret) {
      legacyCalls += 1;
      return secret === "legacy-secret" || secret.startsWith("twcap2.");
    },
    verifyV2AccessToken(token, expectedRole) {
      v2Calls += 1;
      if (token === "twcap2.invalid") {
        throw Object.assign(new Error("redacted"), { code: "AUTH_INVALID" });
      }
      return authContext(expectedRole);
    },
  };

  const legacy = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/client",
    search: "?secret=legacy-secret&hostId=mac-admin",
    authorizationHeaders: [],
    legacyQuerySecret: "legacy-secret",
    offeredProtocols: [],
  }, dependencies);
  assert.deepEqual(legacy, {
    outcome: "accept",
    stack: "v1",
    credentialKind: "legacy_shared_secret",
    role: "client",
    selectedProtocol: null,
    fallback: false,
  });
  assert.equal(legacyCalls, 1);
  assert.equal(v2Calls, 0);

  const v2 = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/client",
    search: "",
    authorizationHeaders: ["Bearer twcap2.valid"],
    offeredProtocols: ["tw-relay.v2"],
  }, dependencies);
  assert.equal(v2.outcome, "accept");
  assert.equal(v2.stack, "v2");
  assert.equal(v2.selectedProtocol, "tw-relay.v2");
  assert.equal(v2.fallback, false);
  assert.equal(v2Calls, 1);
  assert.equal(legacyCalls, 1);

  const rejectedV2 = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/client",
    search: "",
    authorizationHeaders: ["Bearer twcap2.invalid"],
    offeredProtocols: ["tw-relay.v2"],
  }, dependencies);
  assert.deepEqual(rejectedV2, {
    outcome: "reject",
    status: 401,
    errorCode: "AUTH_INVALID",
    fallback: false,
  });
  assert.equal(v2Calls, 2);
  assert.equal(legacyCalls, 1, "a rejected twcap2 credential must never reach v1 verification");

  const queryV2 = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/client",
    search: "?secret=twcap2.valid",
    authorizationHeaders: [],
    legacyQuerySecret: "twcap2.valid",
    offeredProtocols: ["tw-relay.v1"],
  }, dependencies);
  assert.equal(queryV2.outcome, "reject");
  assert.equal(queryV2.errorCode, "AUTH_INVALID");
  assert.equal(v2Calls, 2);
  assert.equal(legacyCalls, 1);

  const wrongDialect = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/host",
    search: "",
    authorizationHeaders: ["Bearer twcap2.valid"],
    offeredProtocols: ["tw-relay.v1", "tw-relay.host.v2"],
  }, dependencies);
  assert.equal(wrongDialect.outcome, "reject");
  assert.equal(wrongDialect.status, 426);
  assert.equal(wrongDialect.fallback, false);

  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(core, "partial-host", hostHello({ capabilities: ["error.structured.v1"] }));
  const unavailable = core.openClientRoute(randomUUID(), authContext("client"));
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(unavailable.actions[0].kind, "route_unavailable");
  assert.equal(unavailable.actions[0].closeCode, 4406);
});

test("host registration commits delivery before admission and supersedes only a different instance", async () => {
  const fenceCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const missingCarrier = await fenceCore.receiveHostFrame(
    "host-missing-source",
    new Uint8Array(),
  );
  assert.equal(missingCarrier.actions[0].kind, "close_host");
  assert.equal(
    Object.hasOwn(missingCarrier.actions[0], "connectionIncarnation"),
    false,
    "only an entirely absent source carrier uses the incarnation-less close fallback",
  );
  const fenceIncarnation = randomUUID();
  fenceCore.attachHostCarrier(
    "host-fence-pending",
    authContext("host"),
    fenceIncarnation,
  );
  const pending = await fenceCore.receiveHostFrame(
    "host-fence-pending",
    carrierBytes(hostHello()),
  );
  const registeredDelivery = pending.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(registeredDelivery.deliveryId);
  assert.equal(registeredDelivery.connectionIncarnation, fenceIncarnation);
  assert.equal(fenceCore.inspectHost(HOST_ID), undefined);
  assert.equal(
    fenceCore.openClientRoute(randomUUID(), authContext("client")).error.code,
    "HOST_OFFLINE",
  );
  assert.equal(fenceCore.drainHostCarrier("host-fence-pending").length, 0);
  assert.equal(
    fenceCore.acknowledgeHostControlDelivery(
      "host-fence-pending",
      registeredDelivery.deliveryId,
    ).accepted,
    true,
  );
  assert.equal(fenceCore.inspectHost(HOST_ID).state, "online");

  const lostAckCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const lostAckIncarnation = randomUUID();
  lostAckCore.attachHostCarrier(
    "host-registration-ack-lost",
    authContext("host"),
    lostAckIncarnation,
  );
  const ackLost = await lostAckCore.receiveHostFrame(
    "host-registration-ack-lost",
    carrierBytes(hostHello()),
  );
  const lostDelivery = ackLost.actions.find((action) => action.deliveryId);
  assert.ok(lostDelivery);
  assert.equal(lostDelivery.connectionIncarnation, lostAckIncarnation);
  assert.equal(lostAckCore.disconnectHost("host-registration-ack-lost").accepted, true);
  assert.equal(lostAckCore.inspectHost(HOST_ID), undefined);
  assert.equal(
    lostAckCore.acknowledgeHostControlDelivery(
      "host-registration-ack-lost",
      lostDelivery.deliveryId,
    ).accepted,
    false,
    "a lost host.registered ACK cannot resurrect the disconnected newcomer",
  );

  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const hostEpoch = randomUUID();
  const firstInstance = randomUUID();
  const first = await registerHost(core, "host-old", hostHello({ hostEpoch, hostInstanceId: firstInstance }));
  assert.equal(first.registration.connectionIncarnation, first.connectionIncarnation);
  const firstDirectory = core.inspectHost(HOST_ID);
  assert.equal(firstDirectory.state, "online");
  assert.equal(firstDirectory.revision, "1");
  assert.equal(firstDirectory.connectorId, first.connectorId);
  assert.deepEqual(core.readHostPresence(authContext("client")).payload, {
    brokerEpoch: core.brokerEpoch,
    revision: "1",
    state: "online",
    reason: "connected",
    hostEpoch,
    hostInstanceId: firstInstance,
    previousHostInstanceId: null,
    observedAtMs: NOW_MS,
  });
  const firstSnapshot = core.readHostsSnapshot(authContext("client"), "hosts-first");
  assert.equal(firstSnapshot.payload.items.length, 1);
  assert.equal(firstSnapshot.payload.items[0].hostId, HOST_ID);
  assert.equal(
    core.readHostsSnapshot(authContext("client", { hostId: "other-host" }), "hosts-other"),
    undefined,
    "directory reads never fall back to a global or empty-list view",
  );
  assert.equal(
    core.readHostPresence(authContext("client", { hostId: "other-host" })),
    undefined,
  );

  const duplicateIncarnation = randomUUID();
  core.attachHostCarrier(
    "host-duplicate",
    authContext("host", { jti: "duplicate-jti" }),
    duplicateIncarnation,
  );
  const duplicate = await core.receiveHostFrame("host-duplicate", carrierBytes(hostHello({
    hostEpoch,
    hostInstanceId: firstInstance,
  })));
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.error.code, "DUPLICATE_CONNECTOR");
  const duplicateError = duplicate.actions.find((action) => action.kind === "send_host");
  assert.equal(duplicateError.frame.type, "carrier.error");
  assert.equal(duplicateError.frame.connectorId, null);
  assert.equal(duplicateError.frame.payload.failedType, "host.hello");
  assert.equal(duplicate.actions.some((action) => (
    action.kind === "close_host" && action.closeCode === 4411
  )), true);
  assert.equal(duplicate.actions.filter((action) => (
    action.kind === "send_host" || action.kind === "close_host"
  )).every((action) => action.connectionIncarnation === duplicateIncarnation), true);
  assert.equal(core.inspectHost(HOST_ID).connectorId, first.connectorId);
  assert.equal(core.inspectHost(HOST_ID).revision, "1");

  const winningInstance = randomUUID();
  const winnerIncarnation = randomUUID();
  core.attachHostCarrier(
    "host-winner",
    authContext("host", { jti: "winner-jti" }),
    winnerIncarnation,
  );
  const pendingWinner = await core.receiveHostFrame("host-winner", carrierBytes(hostHello({
    hostEpoch, hostInstanceId: winningInstance,
  })));
  const pendingRegistration = pendingWinner.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(pendingRegistration);
  assert.equal(pendingRegistration.connectionIncarnation, winnerIncarnation);
  assert.equal(core.inspectHost(HOST_ID).connectorId, first.connectorId);
  assert.equal(core.openClientRoute(randomUUID(), authContext("client")).accepted, true);
  assert.equal(pendingWinner.actions.some((action) => action.frame?.type === "host.superseded"), false);
  const winnerCommit = core.acknowledgeHostControlDelivery(
    "host-winner",
    pendingRegistration.deliveryId,
  );
  assert.equal(winnerCommit.accepted, true);
  const winner = {
    connectorId: pendingRegistration.frame.connectorId,
    result: winnerCommit,
  };
  const directory = core.inspectHost(HOST_ID);
  assert.equal(directory.state, "online");
  assert.equal(directory.revision, "2");
  assert.equal(directory.hostInstanceId, winningInstance);
  assert.equal(directory.connectorId, winner.connectorId);
  assert.deepEqual(core.readHostPresence(authContext("client")).payload, {
    brokerEpoch: core.brokerEpoch,
    revision: "2",
    state: "online",
    reason: "superseded",
    hostEpoch,
    hostInstanceId: winningInstance,
    previousHostInstanceId: firstInstance,
    observedAtMs: NOW_MS,
  });
  const superseded = winner.result.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.superseded"
  ));
  assert.equal(superseded.transportId, "host-old");
  assert.equal(superseded.connectionIncarnation, first.connectionIncarnation);
  assert.equal(superseded.frame.payload.losingConnectorId, first.connectorId);
  assert.equal(superseded.frame.payload.winningConnectorId, winner.connectorId);
  assert.equal(winner.result.actions.some((action) => (
    action.kind === "close_host"
      && action.transportId === "host-old"
      && action.connectionIncarnation === first.connectionIncarnation
      && action.closeCode === 4409
  )), true);

  core.disconnectHost("host-winner");
  const offline = core.readHostsSnapshot(authContext("client"), "hosts-offline");
  assert.equal(offline.payload.items.length, 1);
  assert.equal(offline.payload.items[0].state, "offline");
  assert.equal(offline.payload.items[0].hostEpoch, hostEpoch);
  assert.equal(offline.payload.items[0].hostInstanceId, winningInstance);
  assert.equal(core.readHostPresence(authContext("client")).payload.reason, "disconnected");
  assert.equal(core.readHostPresence(authContext("client")).payload.revision, "3");

  const reconnectedInstance = randomUUID();
  await registerHost(core, "host-reconnected", hostHello({
    hostEpoch,
    hostInstanceId: reconnectedInstance,
  }));
  const reconnectedPresence = core.readHostPresence(authContext("client")).payload;
  assert.equal(reconnectedPresence.revision, "4");
  assert.equal(reconnectedPresence.reason, "reconnected");
  assert.equal(reconnectedPresence.hostInstanceId, reconnectedInstance);
  assert.equal(reconnectedPresence.previousHostInstanceId, winningInstance);
});

test("carrier route admission hard-bounds disconnect cleanup production", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const transportId = "host-route-hard-ceiling";
  await registerHost(core, transportId);
  const ceiling = broker.RELAY_V2_BROKER_LIMITS.maxRoutesPerCarrier;
  assert.ok(ceiling > 128);

  for (let index = 0; index < ceiling; index += 1) {
    const connectionId = `client-hard-ceiling-${index.toString().padStart(3, "0")}`;
    const opened = core.openClientRoute(connectionId, authContext("client", {
      jti: `hard-ceiling-jti-${index}`,
    }));
    assert.equal(opened.accepted, true);
  }
  const overflow = core.openClientRoute("client-hard-ceiling-overflow", authContext("client", {
    jti: "hard-ceiling-overflow-jti",
  }));
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.error.code, "BUSY");
  assert.equal(overflow.actions[0].kind, "route_unavailable");

  const disconnected = core.disconnectHost(transportId);
  assert.equal(disconnected.accepted, true);
  assert.equal(disconnected.actions.length, ceiling);
  assert.equal(disconnected.actions.every((action) => action.kind === "route_unavailable"), true);
  assert.equal(core.inspectHost(HOST_ID).state, "offline");
});

test("claim-scoped hosts.snapshot stays in broker and readiness never copies hello extensions", async () => {
  const claimedCapabilities = [
    ...broker.RELAY_V2_REQUIRED_CAPABILITIES,
    "agent.transcript-lifecycle.v1",
  ];
  const disabled = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(disabled, "host-directory-disabled", hostHello({
    capabilities: claimedCapabilities,
  }));
  assert.deepEqual(disabled.inspectHost(HOST_ID).capabilities, []);
  const disabledRoute = await openRoute(
    disabled,
    "host-directory-disabled",
    "client-directory-disabled",
  );
  assert.deepEqual(disabledRoute.acknowledged.actions[0].capabilities, []);

  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    baseCapabilityReadiness: broker.RELAY_V2_REQUIRED_CAPABILITIES,
  });
  await registerHost(core, "host-directory", hostHello({
    capabilities: claimedCapabilities,
  }));
  const directory = core.readHostsSnapshot(authContext("client"), "hosts-direct");
  assert.deepEqual(
    directory.payload.items[0].capabilities,
    [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  );

  const route = await openRoute(core, "host-directory", "client-directory");
  const openedAction = route.acknowledged.actions.find((action) => (
    action.kind === "route_opened"
  ));
  assert.deepEqual(
    openedAction.capabilities,
    [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  );

  const snapshotRequest = core.forwardClientFrame(
    route.connectionId,
    publicBytes(hostsSnapshotGet("hosts-routed")),
  );
  assert.equal(snapshotRequest.accepted, true);
  assert.equal(
    core.drainHostCarrier("host-directory").length,
    0,
    "broker-authoritative directory requests never reach relay-host",
  );
  const [delivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.ok(delivery);
  const response = codec.decodeRelayV2WebSocketFrame("public", delivery.bytes).frame;
  assert.equal(response.type, "hosts.snapshot");
  assert.equal(response.requestId, "hosts-routed");
  assert.deepEqual(response.payload.items.map((item) => item.hostId), [HOST_ID]);
  core.acknowledgeClientDelivery(route.connectionId, delivery.deliveryId);
});

test("persistent auth-control authority replays reauthentication ACK and preserves old context on failure", async () => {
  const seenJtis = [];
  let persistedAck;
  const nextAuth = authContext("host", { jti: "replacement-jti", expiresAtMs: NOW_MS + 7_200_000 });
  const authority = {
    handle(request) {
      seenJtis.push(request.currentAuthContext.jti);
      if (request.type !== "host.reauthenticate") {
        throw new Error("unexpected control");
      }
      if (request.accessToken === "twcap2.rejected") {
        return {
          outcome: "reject",
          error: {
            code: "AUTH_INVALID",
            message: "Replacement access token is invalid",
            retryable: false,
            retryAfterMs: null,
            commandDisposition: "not_applicable",
            details: null,
          },
        };
      }
      persistedAck ??= {
        carrierVersion: 1,
        type: "host.reauthenticated",
        requestId: request.requestId,
        connectorId: request.connectorId,
        payload: {
          grantId: nextAuth.grantId,
          jti: nextAuth.jti,
          expiresAtMs: nextAuth.expiresAtMs,
          deduplicated: false,
        },
      };
      return {
        outcome: "success",
        response: seenJtis.at(-1) === nextAuth.jti
          ? {
              ...persistedAck,
              payload: { ...persistedAck.payload, deduplicated: true },
            }
          : persistedAck,
        nextAuthContext: nextAuth,
        replayed: seenJtis.at(-1) === nextAuth.jti,
      };
    },
  };
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    authControlAuthority: authority,
  });
  const host = await registerHost(core, "host-auth");
  const directoryBefore = core.inspectHost(HOST_ID);
  const presenceBefore = core.readHostPresence(authContext("client"));
  const requestId = randomUUID();
  const reauth = (accessToken) => carrierBytes({
    carrierVersion: 1,
    type: "host.reauthenticate",
    requestId,
    connectorId: host.connectorId,
    payload: { accessToken },
  });

  const rejected = await core.receiveHostFrame("host-auth", reauth("twcap2.rejected"));
  assert.equal(rejected.accepted, false);
  const [rejectedAck] = core.drainHostCarrier("host-auth", { maxFrames: 1 });
  assert.equal(rejectedAck.frame.type, "carrier.error");
  core.acknowledgeHostDelivery("host-auth", rejectedAck.deliveryId);
  assert.equal(rejected.actions.some((action) => action.kind === "close_host"), false);
  const accepted = await core.receiveHostFrame("host-auth", reauth("twcap2.accepted"));
  assert.equal(accepted.accepted, true);
  const [acceptedAck] = core.drainHostCarrier("host-auth", { maxFrames: 1 });
  core.acknowledgeHostDelivery("host-auth", acceptedAck.deliveryId);
  const replay = await core.receiveHostFrame("host-auth", reauth("twcap2.accepted"));
  assert.equal(replay.accepted, true);
  const [replayedAck] = core.drainHostCarrier("host-auth", { maxFrames: 1 });
  assert.deepEqual(
    { ...replayedAck.frame.payload, deduplicated: false },
    acceptedAck.frame.payload,
  );
  assert.equal(replayedAck.frame.payload.deduplicated, true);
  assert.deepEqual(seenJtis, ["host-auth-jti", "host-auth-jti", "replacement-jti"]);
  assert.deepEqual(core.inspectHost(HOST_ID), directoryBefore);
  assert.deepEqual(core.readHostPresence(authContext("client")), presenceBefore);
});

test("unconfigured enrollment authority returns correlated capability failure without killing carrier", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const host = await registerHost(core, "host-no-authority");
  const result = await core.receiveHostFrame("host-no-authority", carrierBytes({
    carrierVersion: 1,
    type: "enrollment.create",
    requestId: randomUUID(),
    connectorId: host.connectorId,
    payload: { expiresInMs: 60_000, deviceLabel: null },
  }));
  assert.equal(result.accepted, false);
  assert.equal(result.error.code, "CAPABILITY_UNAVAILABLE");
  const [failure] = core.drainHostCarrier("host-no-authority", { maxFrames: 1 });
  assert.equal(failure.frame.type, "carrier.error");
  assert.equal(result.actions.some((action) => action.kind === "close_host"), false);
  assert.equal(core.openClientRoute(randomUUID(), authContext("client")).accepted, true);
});

test("committed exact live-auth fence persists across late attach and preserves unrelated old revisions", async () => {
  const closeSignals = [];
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => { closeSignals.push(signal); },
  });
  await registerHost(core, "host-live-auth");

  const staleVerified = authContext("client", {
    grantId: "revoked-grant",
    jti: "revoked-jti",
  });
  const matched = await openRoute(
    core,
    "host-live-auth",
    "client-live-auth-matched",
    1_048_576,
    HOST_ID,
    staleVerified,
  );
  const unrelated = await openRoute(
    core,
    "host-live-auth",
    "client-live-auth-unrelated",
    1_048_576,
    HOST_ID,
    { grantId: "unrelated-grant", jti: "unrelated-jti" },
  );
  assert.equal(core.forwardClientFrame(
    matched.connectionId,
    publicBytes(clientTerminalAck("matched-queued")),
  ).accepted, true);
  assert.equal(core.forwardClientFrame(
    unrelated.connectionId,
    publicBytes(clientTerminalAck("unrelated-queued")),
  ).accepted, true);
  assert.equal((await core.receiveHostFrame(
    "host-live-auth",
    carrierBytes(hostRouteData(matched.routeOpen, "1", hostTerminalAck("matched-host-queued"))),
  )).accepted, true);
  assert.equal((await core.receiveHostFrame(
    "host-live-auth",
    carrierBytes(hostRouteData(unrelated.routeOpen, "1", hostTerminalAck("unrelated-host-queued"))),
  )).accepted, true);

  const barrier = core.liveAuthorizationFencePort.begin({
    reason: "grant_revoked",
    role: "client",
    hostId: HOST_ID,
    grantId: "revoked-grant",
  });
  assert.equal(core.forwardClientFrame(
    matched.connectionId,
    publicBytes(clientTerminalAck("pending-must-not-dispatch")),
  ).accepted, false);
  assert.equal(core.openClientRoute("pending-late-attach", staleVerified).accepted, false);
  assert.equal(core.forwardClientFrame(
    unrelated.connectionId,
    publicBytes(clientTerminalAck("unrelated-during-pending")),
  ).accepted, true);

  barrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  assert.equal(closeSignals.length, 1);
  assert.equal(closeSignals[0].connectionId, matched.connectionId);
  assert.equal(closeSignals[0].reason, "grant_revoked");
  assert.equal(closeSignals[0].authorization.authorizationRevision, "2");
  assert.equal(closeSignals[0].authorization.authorizationFence, "authorization-fence-2");
  assert.equal(Object.hasOwn(closeSignals[0].authorization, "accessToken"), false);
  assert.equal(Object.hasOwn(closeSignals[0].authorization, "secret"), false);

  const hostDeliveries = core.drainHostCarrier("host-live-auth");
  assert.equal(hostDeliveries.some((delivery) => (
    delivery.frame.type === "route.data"
      && delivery.frame.routeId === matched.routeOpen.routeId
  )), false);
  assert.equal(hostDeliveries.some((delivery) => (
    delivery.frame.type === "route.unbind"
      && delivery.frame.routeId === matched.routeOpen.routeId
  )), true);
  assert.equal(hostDeliveries.some((delivery) => (
    delivery.frame.type === "route.data"
      && delivery.frame.routeId === unrelated.routeOpen.routeId
  )), true);
  assert.equal(core.drainClient(matched.connectionId).length, 0);
  assert.equal(core.drainClient(unrelated.connectionId).length, 1);

  assert.equal(core.openClientRoute("committed-late-attach", staleVerified).accepted, false);
  assert.equal(core.openClientRoute(
    "unrelated-old-revision",
    authContext("client", {
      grantId: "another-unrelated-grant",
      jti: "another-unrelated-jti",
      authorizationRevision: "1",
      authorizationFence: "authorization-fence-1",
    }),
  ).accepted, true);
  assert.equal(core.forwardClientFrame(
    matched.connectionId,
    publicBytes(clientTerminalAck("after-commit")),
  ).accepted, false);
  barrier.committed({
    authorizationRevision: "3",
    authorizationFence: "authorization-fence-3",
  });
  barrier.cancelled();
  barrier.failClosed();
  assert.equal(closeSignals.length, 1, "close signal is once-only");
});

test("unscoped kid removal gives direct host and client the exact committed reason and receipt", async () => {
  const closeSignals = [];
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => { closeSignals.push(signal); },
  });
  await registerHost(core, "host-shared-kid");
  await openRoute(core, "host-shared-kid", "client-shared-kid");
  const barrier = core.liveAuthorizationFencePort.begin({
    reason: "kid_removed",
    kid: "key-2026-07",
  });
  barrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  assert.equal(closeSignals.length, 2);
  assert.deepEqual(
    closeSignals.map((signal) => signal.connectionKind).sort(),
    ["client", "host"],
  );
  for (const signal of closeSignals) {
    assert.equal(signal.reason, "kid_removed");
    assert.equal(signal.authorization.authorizationRevision, "2");
    assert.equal(signal.authorization.authorizationFence, "authorization-fence-2");
  }
  barrier.committed({
    authorizationRevision: "3",
    authorizationFence: "authorization-fence-3",
  });
  assert.equal(closeSignals.length, 2);
});

test("credential-authority ready loss synchronously latches every broker gate once", async () => {
  const closeSignals = [];
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => { closeSignals.push(signal); },
  });
  await registerHost(core, "host-authority-ready-loss");
  const route = await openRoute(
    core,
    "host-authority-ready-loss",
    "client-authority-ready-loss",
  );
  assert.equal(core.forwardClientFrame(
    route.connectionId,
    publicBytes(clientTerminalAck("queued-before-authority-ready-loss")),
  ).accepted, true);

  core.liveAuthorizationFencePort.failClosed();
  core.liveAuthorizationFencePort.failClosed();

  assert.equal(core.inspectLiveAuthCompositionLatch(), "latched_fail_closed");
  assert.deepEqual(
    closeSignals.map((signal) => signal.connectionKind).sort(),
    ["client", "host"],
  );
  assert.equal(core.drainHostCarrier("host-authority-ready-loss").length, 0);
  assert.equal(core.drainClient(route.connectionId).length, 0);
  assert.equal(core.forwardClientFrame(
    route.connectionId,
    publicBytes(clientTerminalAck("after-authority-ready-loss")),
  ).accepted, false);
  assert.equal(core.openClientRoute(
    "late-client-after-authority-ready-loss",
    authContext("client", { jti: "late-client-ready-loss-jti" }),
  ).accepted, false);

  let armTimeReentry = false;
  let timeReentered = false;
  let authControlCalls = 0;
  const reentrantCloseSignals = [];
  let reentrantCore;
  reentrantCore = new broker.RelayV2BrokerCore({
    now: () => {
      if (armTimeReentry && !timeReentered) {
        timeReentered = true;
        reentrantCore.liveAuthorizationFencePort.failClosed();
      }
      return NOW_MS;
    },
    authControlAuthority: {
      handle() {
        authControlCalls += 1;
        throw new Error("auth control must not run after reentrant ready loss");
      },
    },
    onLiveAuthorizationClose: (signal) => { reentrantCloseSignals.push(signal); },
  });
  const reentrantHost = await registerHost(reentrantCore, "host-time-reentry");
  const reentrantRoute = await openRoute(
    reentrantCore,
    "host-time-reentry",
    "client-time-reentry",
  );
  assert.equal(reentrantCore.forwardClientFrame(
    reentrantRoute.connectionId,
    publicBytes(clientTerminalAck("queued-before-time-reentry")),
  ).accepted, true);
  assert.equal((await reentrantCore.receiveHostFrame(
    "host-time-reentry",
    carrierBytes(hostRouteData(
      reentrantRoute.routeOpen,
      "1",
      hostTerminalAck("queued-client-before-time-reentry"),
    )),
  )).accepted, true);

  armTimeReentry = true;
  const authControl = await reentrantCore.receiveHostFrame(
    "host-time-reentry",
    carrierBytes({
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId: randomUUID(),
      connectorId: reentrantHost.connectorId,
      payload: { accessToken: "twcap2.must-not-reach-authority" },
    }),
  );
  assert.equal(authControl.accepted, false);
  assert.equal(timeReentered, true);
  assert.equal(authControlCalls, 0);
  assert.equal(reentrantCore.drainHostCarrier("host-time-reentry").length, 0);
  assert.equal(reentrantCore.drainClient(reentrantRoute.connectionId).length, 0);
  assert.deepEqual(
    reentrantCloseSignals.map((signal) => signal.connectionKind).sort(),
    ["client", "host"],
  );
});

test("queued dispatch and host route admission recheck injected expiry", async () => {
  let now = NOW_MS;
  const closeSignals = [];
  const core = new broker.RelayV2BrokerCore({
    now: () => now,
    onLiveAuthorizationClose: (signal) => { closeSignals.push(signal); },
  });
  await registerHost(core, "host-expiry-dispatch");
  const clientToHost = await openRoute(
    core,
    "host-expiry-dispatch",
    "client-expiry-to-host",
    1_048_576,
    HOST_ID,
    { expiresAtMs: NOW_MS + 1 },
  );
  const hostToClient = await openRoute(
    core,
    "host-expiry-dispatch",
    "client-expiry-from-host",
    1_048_576,
    HOST_ID,
    { expiresAtMs: NOW_MS + 1 },
  );
  assert.equal(core.forwardClientFrame(
    clientToHost.connectionId,
    publicBytes(clientTerminalAck("expires-before-host-drain")),
  ).accepted, true);
  assert.equal((await core.receiveHostFrame(
    "host-expiry-dispatch",
    carrierBytes(hostRouteData(
      hostToClient.routeOpen,
      "1",
      hostTerminalAck("expires-before-client-drain"),
    )),
  )).accepted, true);

  now = NOW_MS + 2;
  assert.equal(core.drainHostCarrier("host-expiry-dispatch").length, 0);
  assert.equal(core.drainClient(hostToClient.connectionId).length, 0);
  assert.deepEqual(
    closeSignals.filter((signal) => signal.connectionKind === "client")
      .map((signal) => signal.connectionId)
      .sort(),
    [clientToHost.connectionId, hostToClient.connectionId].sort(),
  );

  now = NOW_MS + 3_600_001;
  const afterHostExpiry = core.openClientRoute(
    "client-after-host-expiry",
    authContext("client", {
      expiresAtMs: NOW_MS + 7_200_000,
      jti: "client-after-host-expiry-jti",
    }),
  );
  assert.equal(afterHostExpiry.accepted, false);
  assert.equal(closeSignals.filter((signal) => signal.connectionKind === "host").length, 1);
  assert.equal(core.drainHostCarrier("host-expiry-dispatch").length, 0);

  let admissionNow = NOW_MS;
  const admissionCloseSignals = [];
  const admissionCore = new broker.RelayV2BrokerCore({
    now: () => admissionNow,
    onLiveAuthorizationClose: (signal) => { admissionCloseSignals.push(signal); },
  });
  await registerHost(
    admissionCore,
    "host-expiry-client-admission",
    hostHello(),
    { expiresAtMs: NOW_MS + 1 },
  );
  const rejectedAtAdmission = await openRoute(
    admissionCore,
    "host-expiry-client-admission",
    "client-valid-at-host-admission-expiry",
    1_048_576,
    HOST_ID,
    { expiresAtMs: NOW_MS + 7_200_000 },
  );
  admissionNow = NOW_MS + 2;
  assert.equal(admissionCore.forwardClientFrame(
    rejectedAtAdmission.connectionId,
    publicBytes(clientTerminalAck("host-expired-before-client-admission")),
  ).accepted, false);
  assert.equal(admissionCore.drainHostCarrier("host-expiry-client-admission").length, 0);
  assert.deepEqual(
    admissionCloseSignals.map((signal) => [signal.connectionKind, signal.reason]).sort(),
    [
      ["client", "host_authorization_fenced"],
      ["host", "access_expired"],
    ],
  );

  let sourceNow = NOW_MS;
  const sourceCloseSignals = [];
  const sourceCore = new broker.RelayV2BrokerCore({
    now: () => sourceNow,
    onLiveAuthorizationClose: (signal) => { sourceCloseSignals.push(signal); },
  });
  await registerHost(
    sourceCore,
    "host-expiry-client-drain",
    hostHello(),
    { expiresAtMs: NOW_MS + 1 },
  );
  const queuedFromHost = await openRoute(
    sourceCore,
    "host-expiry-client-drain",
    "client-valid-after-host-expiry",
    1_048_576,
    HOST_ID,
    { expiresAtMs: NOW_MS + 7_200_000 },
  );
  assert.equal((await sourceCore.receiveHostFrame(
    "host-expiry-client-drain",
    carrierBytes(hostRouteData(
      queuedFromHost.routeOpen,
      "1",
      hostTerminalAck("host-expires-before-client-drain"),
    )),
  )).accepted, true);
  sourceNow = NOW_MS + 2;
  assert.equal(sourceCore.drainClient(queuedFromHost.connectionId).length, 0);
  assert.deepEqual(
    sourceCloseSignals.map((signal) => [
      signal.connectionKind,
      signal.reason,
    ]).sort(),
    [
      ["client", "host_authorization_fenced"],
      ["host", "access_expired"],
    ],
  );
});

test("throwing receipt and callback cleanup failures latch all dispatch gates", async () => {
  const receiptSignals = [];
  const receiptCore = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => { receiptSignals.push(signal); },
  });
  await registerHost(receiptCore, "host-throwing-receipt");
  assert.throws(() => receiptCore.liveAuthorizationFencePort.begin({
    reason: "unknown_reason",
    role: "bogus",
    hostId: HOST_ID,
    grantId: "grant",
  }));
  assert.throws(() => receiptCore.liveAuthorizationFencePort.begin({
    reason: "grant_revoked",
    role: "bogus",
    hostId: HOST_ID,
    grantId: "grant",
    jti: "wrong-variant-field",
  }));

  const receiptBarrier = receiptCore.liveAuthorizationFencePort.begin({
    reason: "kid_removed",
    role: "host",
    hostId: HOST_ID,
    kid: "key-2026-07",
  });
  let getterCalls = 0;
  const throwingReceipt = {};
  Object.defineProperties(throwingReceipt, {
    authorizationRevision: {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("receipt getter must not run");
      },
    },
    authorizationFence: { enumerable: true, value: "authorization-fence-2" },
  });
  assert.doesNotThrow(() => receiptBarrier.committed(throwingReceipt));
  assert.equal(getterCalls, 0, "accessor receipt is rejected from its descriptor");
  assert.equal(receiptCore.inspectLiveAuthCompositionLatch(), "latched_fail_closed");
  assert.equal(receiptCore.drainHostCarrier("host-throwing-receipt").length, 0);
  receiptBarrier.cancelled();
  assert.equal(receiptCore.inspectLiveAuthCompositionLatch(), "latched_fail_closed");

  let throwTime = false;
  let throwFirstClose = true;
  const cleanupSignals = [];
  const cleanupCore = new broker.RelayV2BrokerCore({
    now: () => {
      if (throwTime) throw new Error("directory clock failed");
      return NOW_MS;
    },
    onLiveAuthorizationClose: (signal) => {
      cleanupSignals.push(signal);
      if (throwFirstClose) {
        throwFirstClose = false;
        throwTime = true;
        throw new Error("socket owner failed");
      }
    },
  });
  await registerHost(cleanupCore, "host-global-cleanup");
  const matched = await openRoute(
    cleanupCore,
    "host-global-cleanup",
    "client-global-matched",
    1_048_576,
    HOST_ID,
    { grantId: "global-revoked-grant" },
  );
  const unrelated = await openRoute(
    cleanupCore,
    "host-global-cleanup",
    "client-global-unrelated",
    1_048_576,
    HOST_ID,
    { grantId: "global-unrelated-grant" },
  );
  assert.equal(cleanupCore.forwardClientFrame(
    unrelated.connectionId,
    publicBytes(clientTerminalAck("queued-before-global-latch")),
  ).accepted, true);
  const cleanupBarrier = cleanupCore.liveAuthorizationFencePort.begin({
    reason: "grant_revoked",
    role: "client",
    hostId: HOST_ID,
    grantId: "global-revoked-grant",
  });
  cleanupBarrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  assert.equal(cleanupCore.inspectLiveAuthCompositionLatch(), "latched_fail_closed");
  assert.deepEqual(
    cleanupSignals.map((signal) => signal.connectionKind === "host"
      ? "host-global-cleanup"
      : signal.connectionId).sort(),
    ["client-global-matched", "client-global-unrelated", "host-global-cleanup"].sort(),
  );
  assert.equal(new Set(cleanupSignals.map((signal) => signal.connectionIncarnation)).size, 3);
  assert.equal(cleanupCore.drainHostCarrier("host-global-cleanup").length, 0);
  assert.equal(cleanupCore.drainClient(matched.connectionId).length, 0);
  assert.equal(cleanupCore.drainClient(unrelated.connectionId).length, 0);
});

test("authorization clone rejects credential extras and getter TOCTOU without leaking close state", async () => {
  const closeSignals = [];
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => { closeSignals.push(signal); },
  });
  await registerHost(core, "host-closed-auth");

  const credentialBearing = {
    ...authContext("client"),
    accessToken: "must-never-enter-runtime-state",
  };
  const upgrade = await broker.dispatchRelayBrokerUpgrade({
    pathname: "/client",
    search: "",
    authorizationHeaders: ["Bearer twcap2.redacted"],
    legacyQuerySecret: null,
    offeredProtocols: ["tw-relay.v2"],
  }, {
    verifyLegacySecret: () => true,
    verifyV2AccessToken: () => credentialBearing,
  });
  assert.equal(upgrade.outcome, "reject");
  assert.equal(core.openClientRoute("credential-extra", credentialBearing).accepted, false);
  assert.throws(() => core.attachHostCarrier("host-secret-extra", {
    ...authContext("host", { hostId: "other-host" }),
    secret: "must-never-enter-close-signal",
  }));

  let getterCalls = 0;
  const getterAuth = authContext("client");
  Object.defineProperty(getterAuth, "hostId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return getterCalls === 1 ? HOST_ID : "other-host";
    },
  });
  assert.equal(core.inspectClientAdmission(getterAuth).outcome, "reject");
  assert.equal(core.readHostsSnapshot(getterAuth, "getter-snapshot"), undefined);
  assert.equal(core.readHostPresence(getterAuth), undefined);
  assert.equal(getterCalls, 0, "authorization accessors are never evaluated");
  assert.equal(closeSignals.length, 0);
});

test("host live-auth close keeps transport tombstone through reentrant signal and exposes incarnation", async () => {
  const closeSignals = [];
  let sameIdRejected = false;
  let unrelatedAttached = false;
  let core;
  core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    onLiveAuthorizationClose: (signal) => {
      closeSignals.push(signal);
      if (signal.connectionKind !== "host") return;
      try {
        core.attachHostCarrier("host-aba", authContext("host", {
          hostId: "unrelated-host",
          kid: "unrelated-kid",
          jti: "same-id-new-incarnation",
        }));
      } catch {
        sameIdRejected = true;
      }
      core.attachHostCarrier("host-unrelated-new-id", authContext("host", {
        hostId: "unrelated-host",
        kid: "unrelated-kid",
        jti: "new-id-new-incarnation",
      }));
      unrelatedAttached = true;
    },
  });
  await registerHost(core, "host-aba");
  const barrier = core.liveAuthorizationFencePort.begin({
    reason: "kid_removed",
    role: "host",
    hostId: HOST_ID,
    kid: "key-2026-07",
  });
  barrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  assert.equal(sameIdRejected, true);
  assert.equal(unrelatedAttached, true);
  assert.equal(closeSignals.length, 1);
  assert.equal(closeSignals[0].transportId, "host-aba");
  assert.match(closeSignals[0].connectionIncarnation, /^[0-9a-f-]{36}$/i);

  const unrelatedHello = await core.receiveHostFrame(
    "host-unrelated-new-id",
    carrierBytes(hostHello({ hostId: "unrelated-host" })),
  );
  assert.equal(unrelatedHello.accepted, true);
  assert.equal(core.drainHostCarrier("host-unrelated-new-id").length, 0);
});

test("auth-control await cannot replace a concurrently fenced current or replacement authorization", async () => {
  let resolveCurrent;
  const currentAuthority = {
    handle() {
      return new Promise((resolve) => { resolveCurrent = resolve; });
    },
  };
  const currentCore = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    authControlAuthority: currentAuthority,
    onLiveAuthorizationClose: () => {},
  });
  const currentHost = await registerHost(currentCore, "host-reauth-current-race");
  const currentRequestId = randomUUID();
  const currentResultPromise = currentCore.receiveHostFrame(
    "host-reauth-current-race",
    carrierBytes({
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId: currentRequestId,
      connectorId: currentHost.connectorId,
      payload: { accessToken: "twcap2.replacement-redacted" },
    }),
  );
  const currentBarrier = currentCore.liveAuthorizationFencePort.begin({
    reason: "kid_removed",
    role: "host",
    hostId: HOST_ID,
    kid: "key-2026-07",
  });
  currentBarrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  const nextCurrent = authContext("host", {
    jti: "replacement-current-jti",
    kid: "replacement-kid",
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  resolveCurrent({
    outcome: "success",
    replayed: false,
    nextAuthContext: nextCurrent,
    response: {
      carrierVersion: 1,
      type: "host.reauthenticated",
      requestId: currentRequestId,
      connectorId: currentHost.connectorId,
      payload: {
        grantId: nextCurrent.grantId,
        jti: nextCurrent.jti,
        expiresAtMs: nextCurrent.expiresAtMs,
        deduplicated: false,
      },
    },
  });
  const currentResult = await currentResultPromise;
  assert.equal(currentResult.accepted, false);
  assert.equal(currentResult.error.code, "HOST_SUPERSEDED");

  let resolveReplacement;
  const replacementAuthority = {
    handle() {
      return new Promise((resolve) => { resolveReplacement = resolve; });
    },
  };
  const replacementCore = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    authControlAuthority: replacementAuthority,
    onLiveAuthorizationClose: () => {},
  });
  const replacementHost = await registerHost(replacementCore, "host-reauth-replacement-race");
  const replacementRequestId = randomUUID();
  const replacementResultPromise = replacementCore.receiveHostFrame(
    "host-reauth-replacement-race",
    carrierBytes({
      carrierVersion: 1,
      type: "host.reauthenticate",
      requestId: replacementRequestId,
      connectorId: replacementHost.connectorId,
      payload: { accessToken: "twcap2.replacement-redacted" },
    }),
  );
  const replacementBarrier = replacementCore.liveAuthorizationFencePort.begin({
    reason: "kid_removed",
    role: "host",
    hostId: HOST_ID,
    kid: "replacement-kid",
  });
  replacementBarrier.committed({
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  const fencedReplacement = authContext("host", {
    jti: "fenced-replacement-jti",
    kid: "replacement-kid",
    authorizationRevision: "2",
    authorizationFence: "authorization-fence-2",
  });
  resolveReplacement({
    outcome: "success",
    replayed: false,
    nextAuthContext: fencedReplacement,
    response: {
      carrierVersion: 1,
      type: "host.reauthenticated",
      requestId: replacementRequestId,
      connectorId: replacementHost.connectorId,
      payload: {
        grantId: fencedReplacement.grantId,
        jti: fencedReplacement.jti,
        expiresAtMs: fencedReplacement.expiresAtMs,
        deduplicated: false,
      },
    },
  });
  const replacementResult = await replacementResultPromise;
  assert.equal(replacementResult.accepted, false);
  assert.equal(replacementResult.error.code, "INTERNAL");
  const [failure] = replacementCore.drainHostCarrier(
    "host-reauth-replacement-race",
    { maxFrames: 1 },
  );
  assert.equal(failure.frame.type, "carrier.error");
});

test("broker public codec rejects forged identity and limits each route to 64 in-flight requests", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(core, "host-public");
  const { connectionId, routeOpen } = await openRoute(core, "host-public");
  for (let index = 0; index < broker.RELAY_V2_BROKER_LIMITS.maxInFlightRequestsPerRoute; index += 1) {
    const result = core.forwardClientFrame(
      connectionId,
      publicBytes(clientHello(`request-${index}`)),
    );
    assert.equal(result.accepted, true, `request ${index + 1}`);
  }
  const busy = core.forwardClientFrame(
    connectionId,
    publicBytes(clientHello("request-overflow")),
  );
  assert.equal(busy.accepted, false);
  assert.equal(busy.error.code, "BUSY");
  assert.equal(busy.error.commandDisposition, "not_accepted");
  const responseBytes = publicBytes({
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: "request-0",
    payload: null,
    error: {
      code: "BUSY",
      message: "busy",
      retryable: true,
      retryAfterMs: 100,
      commandDisposition: "not_accepted",
      details: null,
    },
  });
  const response = await core.receiveHostFrame("host-public", carrierBytes({
    carrierVersion: 1,
    type: "route.data",
    connectorId: routeOpen.connectorId,
    routeId: routeOpen.routeId,
    routeFence: routeOpen.routeFence,
    direction: "host_to_client",
    seq: "1",
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(responseBytes).toString("base64"),
    },
  }));
  assert.equal(response.accepted, true);
  assert.equal(core.forwardClientFrame(
    connectionId,
    publicBytes(clientHello("request-after-response")),
  ).accepted, true);

  const forgedCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(forgedCore, "host-forged");
  const forgedRoute = await openRoute(forgedCore, "host-forged");
  const forged = forgedCore.forwardClientFrame(
    forgedRoute.connectionId,
    publicBytes(clientHello("forged-request", { hostId: "other-host" })),
  );
  assert.equal(forged.accepted, false);
  assert.equal(forged.error.code, "INVALID_ENVELOPE");
  assert.equal(forged.actions.some((action) => (
    action.kind === "close_client" && action.closeCode === 4400
  )), true);

  const malformedCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(malformedCore, "host-malformed");
  const malformedRoute = await openRoute(malformedCore, "host-malformed");
  const malformed = malformedCore.forwardClientFrame(
    malformedRoute.connectionId,
    Buffer.from(JSON.stringify({ ...clientHello("unknown-field"), forgedPrincipalId: "p" })),
  );
  assert.equal(malformed.accepted, false);
  assert.equal(malformed.error.code, "INVALID_ENVELOPE");
});

test("route rejection preserves frozen error semantics and close class", async () => {
  const cases = [
    ["BUSY", 1013],
    ["PERMISSION_DENIED", 4403],
    ["INTERNAL", 1013],
    ["CAPABILITY_UNAVAILABLE", 4406],
    ["HOST_DIALECT_UNAVAILABLE", 4406],
  ];
  for (const [code, closeCode] of cases) {
    const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
    const host = await registerHost(core, `host-reject-${code}`);
    const connectionId = randomUUID();
    assert.equal(core.openClientRoute(connectionId, authContext("client")).accepted, true);
    const [delivery] = core.drainHostCarrier(`host-reject-${code}`, { maxFrames: 1 });
    assert.equal(delivery.frame.type, "route.open");
    core.acknowledgeHostDelivery(`host-reject-${code}`, delivery.deliveryId);
    const frozenError = {
      code,
      message: `route rejected: ${code}`,
      retryable: code === "BUSY" || code === "INTERNAL",
      retryAfterMs: code === "BUSY" ? 250 : null,
      commandDisposition: "not_applicable",
      details: null,
    };
    const rejected = await core.receiveHostFrame(`host-reject-${code}`, carrierBytes({
      carrierVersion: 1,
      type: "route.rejected",
      requestId: delivery.frame.requestId,
      connectorId: host.connectorId,
      routeId: delivery.frame.routeId,
      routeFence: delivery.frame.routeFence,
      payload: null,
      error: frozenError,
    }));
    assert.equal(rejected.accepted, false);
    assert.deepEqual(rejected.error, frozenError);
    assert.equal(rejected.actions[0].closeCode, closeCode);
  }
});

test("post-101 route races choose exactly one welcome or unavailable outcome", async () => {
  const unavailableCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(unavailableCore, "host-race-unavailable");
  const connectionId = "client-race-unavailable";
  assert.equal(
    unavailableCore.openClientRoute(connectionId, authContext("client")).accepted,
    true,
  );
  const [openDelivery] = unavailableCore.drainHostCarrier(
    "host-race-unavailable",
    { maxFrames: 1 },
  );
  unavailableCore.acknowledgeHostDelivery(
    "host-race-unavailable",
    openDelivery.deliveryId,
  );
  const disconnected = unavailableCore.disconnectHost("host-race-unavailable");
  assert.deepEqual(
    disconnected.actions.map((action) => action.kind),
    ["route_unavailable"],
  );
  assert.equal(disconnected.actions[0].connectionId, connectionId);
  assert.equal(disconnected.actions[0].error.code, "HOST_OFFLINE");
  const lateOpened = await unavailableCore.receiveHostFrame(
    "host-race-unavailable",
    carrierBytes({
      carrierVersion: 1,
      type: "route.opened",
      requestId: openDelivery.frame.requestId,
      connectorId: openDelivery.frame.connectorId,
      routeId: openDelivery.frame.routeId,
      routeFence: openDelivery.frame.routeFence,
      payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 1_048_576 },
    }),
  );
  assert.equal(lateOpened.accepted, false);
  assert.equal(lateOpened.actions.some((action) => action.kind === "route_opened"), false);
  assert.equal(lateOpened.actions.some((action) => action.kind === "route_unavailable"), false);

  const welcomeCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(welcomeCore, "host-race-welcome");
  const welcome = await openRoute(
    welcomeCore,
    "host-race-welcome",
    "client-race-welcome",
  );
  assert.deepEqual(
    welcome.acknowledged.actions.map((action) => action.kind),
    ["route_opened"],
  );
  const afterWelcome = welcomeCore.disconnectHost("host-race-welcome");
  assert.equal(afterWelcome.actions.some((action) => action.kind === "route_unavailable"), false);
  assert.equal(afterWelcome.actions.some((action) => action.kind === "close_client"), true);
});

test("route frame limit is the minimum of broker, host hello, and route.opened", async () => {
  const brokerLimited = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(brokerLimited, "host-broker-limit", hostHello({ maxFrameBytes: 2_000_000 }));
  const brokerRoute = brokerLimited.openClientRoute(randomUUID(), authContext("client"));
  assert.equal(brokerRoute.accepted, true);
  assert.equal(
    brokerLimited.drainHostCarrier("host-broker-limit", { maxFrames: 1 })[0]
      .frame.payload.limits.maxFrameBytes,
    broker.RELAY_V2_BROKER_LIMITS.maxFrameBytes,
  );

  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(core, "host-frame-limit", hostHello({ maxFrameBytes: 4_096 }));
  const { connectionId, routeOpen } = await openRoute(
    core,
    "host-frame-limit",
    randomUUID(),
    2_048,
  );
  assert.equal(routeOpen.payload.limits.maxFrameBytes, 4_096);
  const oversizedPublicFrame = publicBytes({
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input",
    streamId: "stream-limit",
    payload: {
      generation: "generation-limit",
      inputSeq: "1",
      encoding: "base64",
      data: Buffer.alloc(1_800).toString("base64"),
    },
  });
  assert.ok(oversizedPublicFrame.byteLength > 2_048);
  const rejected = core.forwardClientFrame(connectionId, oversizedPublicFrame);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.error.code, "INVALID_ENVELOPE");

  const contradictory = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const contradictoryHost = await registerHost(
    contradictory,
    "host-contradictory-limit",
    hostHello({ maxFrameBytes: 4_096 }),
  );
  const contradictoryConnection = randomUUID();
  assert.equal(
    contradictory.openClientRoute(contradictoryConnection, authContext("client")).accepted,
    true,
  );
  const [openDelivery] = contradictory.drainHostCarrier(
    "host-contradictory-limit",
    { maxFrames: 1 },
  );
  contradictory.acknowledgeHostDelivery(
    "host-contradictory-limit",
    openDelivery.deliveryId,
  );
  const invalidOpened = await contradictory.receiveHostFrame(
    "host-contradictory-limit",
    carrierBytes({
      carrierVersion: 1,
      type: "route.opened",
      requestId: openDelivery.frame.requestId,
      connectorId: contradictoryHost.connectorId,
      routeId: openDelivery.frame.routeId,
      routeFence: openDelivery.frame.routeFence,
      payload: { acceptedAtMs: NOW_MS, maxFrameBytes: 8_192 },
    }),
  );
  assert.equal(invalidOpened.accepted, false);
  assert.equal(invalidOpened.actions.some((action) => (
    action.kind === "close_host" && action.closeCode === 4400
  )), true);
  assert.equal(contradictory.inspectHost(HOST_ID).state, "offline");
});

test("route ownership rejects stale connector, fence, and sequence without forwarding payload", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const first = await registerHost(core, "host-route");
  const { connectionId, routeOpen } = await openRoute(core, "host-route");

  assert.equal(core.forwardClientFrame(connectionId, publicBytes(clientTerminalAck("stream-1"))).accepted, true);
  assert.equal(core.forwardClientFrame(connectionId, publicBytes(clientTerminalAck("stream-2"))).accepted, true);
  const clientToHost = core.drainHostCarrier("host-route", { maxFrames: 2 });
  assert.deepEqual(clientToHost.map(({ frame }) => frame.seq), ["1", "2"]);
  assert.deepEqual(clientToHost.map(({ frame }) => frame.direction), [
    "client_to_host",
    "client_to_host",
  ]);
  assert.deepEqual(
    Buffer.from(clientToHost[0].frame.payload.data, "base64"),
    Buffer.from(publicBytes(clientTerminalAck("stream-1"))),
  );
  for (const delivery of clientToHost) {
    core.acknowledgeHostDelivery("host-route", delivery.deliveryId);
  }

  const hostData = (identity, overrides = {}) => ({
    carrierVersion: 1,
    type: "route.data",
    connectorId: identity.connectorId,
    routeId: identity.routeId,
    routeFence: identity.routeFence,
    direction: "host_to_client",
    seq: "1",
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(publicBytes(hostTerminalAck())).toString("base64"),
    },
    ...overrides,
  });
  assert.equal((await core.receiveHostFrame("host-route", carrierBytes(hostData(routeOpen)))).accepted, true);
  const delivered = core.drainClient(connectionId);
  assert.equal(delivered.length, 1);
  assert.deepEqual(Buffer.from(delivered[0].bytes), Buffer.from(publicBytes(hostTerminalAck())));
  core.acknowledgeClientDelivery(connectionId, delivered[0].deliveryId);

  const contiguous = await core.receiveHostFrame("host-route", carrierBytes(hostData(routeOpen, { seq: "2" })));
  assert.equal(contiguous.accepted, true);
  const second = core.drainClient(connectionId);
  assert.equal(second.length, 1);
  core.acknowledgeClientDelivery(connectionId, second[0].deliveryId);

  const winner = await registerHost(core, "host-route-winner", hostHello({
    hostEpoch: first.hello.payload.hostEpoch,
    hostInstanceId: randomUUID(),
  }));
  const staleConnector = await core.receiveHostFrame("host-route", carrierBytes(hostData(routeOpen, { seq: "3" })));
  assert.equal(staleConnector.accepted, false);
  assert.equal(staleConnector.error.code, "HOST_SUPERSEDED");
  assert.equal(core.inspectHost(HOST_ID).connectorId, winner.connectorId);

  const gapCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(gapCore, "host-gap");
  const gapRoute = await openRoute(gapCore, "host-gap");
  const gap = await gapCore.receiveHostFrame(
    "host-gap",
    carrierBytes(hostData(gapRoute.routeOpen, { seq: "2" })),
  );
  assert.equal(gap.accepted, false);
  assert.equal(gap.error.code, "INVALID_ENVELOPE");
  assert.equal(gap.actions.some((action) => (
    action.kind === "close_host" && action.closeCode === 4400
  )), true);
  assert.equal(gapCore.inspectHost(HOST_ID).state, "offline");
  assert.equal(gapCore.drainClient(gapRoute.connectionId).length, 0);

  const fenceCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(fenceCore, "host-fence");
  const fenceRoute = await openRoute(fenceCore, "host-fence");
  const staleFence = await fenceCore.receiveHostFrame("host-fence", carrierBytes(hostData(
    fenceRoute.routeOpen,
    { routeFence: randomUUID() },
  )));
  assert.equal(staleFence.accepted, false);
  assert.equal(staleFence.error.code, "INVALID_ENVELOPE");
  assert.equal(fenceCore.inspectHost(HOST_ID).state, "offline");
  assert.equal(fenceCore.drainClient(fenceRoute.connectionId).length, 0);
});

test("carrier takeover and transport teardown never invent command or terminal finality", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const registered = await registerHost(core, "host-takeover");
  const route = await openRoute(core, "host-takeover", "client-takeover");
  const commandBytes = publicBytes(commandExecute(
    "command-attempt",
    "command-logical",
    registered.hello.payload.hostEpoch,
  ));
  assert.equal(core.forwardClientFrame(route.connectionId, commandBytes).accepted, true);
  const [takenOver] = core.drainHostCarrier("host-takeover", { maxFrames: 1 });
  assert.equal(takenOver.frame.type, "route.data");
  assert.deepEqual(
    Buffer.from(takenOver.frame.payload.data, "base64"),
    Buffer.from(commandBytes),
  );

  const disconnected = core.disconnectHost("host-takeover");
  const serialized = JSON.stringify(disconnected.actions);
  assert.equal(serialized.includes("command.status"), false);
  assert.equal(serialized.includes("command.result"), false);
  assert.equal(serialized.includes("terminal.closed"), false);
  assert.equal(serialized.includes("not_accepted"), false);
  assert.deepEqual(disconnected.actions.map((action) => action.kind), ["close_client"]);

  const unbindCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(unbindCore, "host-unbind-finality");
  const unbindRoute = await openRoute(
    unbindCore,
    "host-unbind-finality",
    "client-unbind-finality",
  );
  assert.equal(unbindCore.unbindClient(unbindRoute.connectionId).accepted, true);
  const [unbind] = unbindCore.drainHostCarrier(
    "host-unbind-finality",
    { maxFrames: 1 },
  );
  assert.equal(unbind.frame.type, "route.unbind");
  assert.equal(JSON.stringify(unbind.frame).includes("terminal.closed"), false);
});

test("frame-count pressure resumes only below the 64-frame low water and closes after five seconds", async () => {
  let now = NOW_MS;
  const core = new broker.RelayV2BrokerCore({ now: () => now });
  await registerHost(core, "host-pressure");
  const { connectionId } = await openRoute(core, "host-pressure");

  let highWater;
  for (let index = 0; index < broker.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    const result = core.forwardClientFrame(
      connectionId,
      publicBytes(clientTerminalAck(`stream-${index}`)),
    );
    assert.equal(result.accepted, true, `frame ${index + 1}`);
    highWater = result;
  }
  assert.equal(highWater.actions.some((action) => action.kind === "pause_client"), true);
  const drained = core.drainHostCarrier("host-pressure", { maxFrames: 65 });
  assert.equal(drained.length, 65);
  for (let index = 0; index < 63; index += 1) {
    const acknowledged = core.acknowledgeHostDelivery("host-pressure", drained[index].deliveryId);
    assert.equal(acknowledged.actions.some((action) => action.kind === "resume_client"), false);
  }
  const atFrameLowWater = core.acknowledgeHostDelivery(
    "host-pressure",
    drained[63].deliveryId,
  );
  assert.equal(atFrameLowWater.actions.some((action) => action.kind === "resume_client"), false);
  const belowFrameLowWater = core.acknowledgeHostDelivery(
    "host-pressure",
    drained[64].deliveryId,
  );
  assert.equal(belowFrameLowWater.actions.some((action) => action.kind === "resume_client"), true);
  let highAgain;
  for (let index = 0; index < 65; index += 1) {
    highAgain = core.forwardClientFrame(
      connectionId,
      publicBytes(clientTerminalAck(`stream-high-again-${index}`)),
    );
    assert.equal(highAgain.accepted, true);
  }
  assert.equal(highAgain.actions.some((action) => action.kind === "pause_client"), true);
  const overflow = core.forwardClientFrame(
    connectionId,
    publicBytes(clientTerminalAck("stream-overflow")),
  );
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.error.code, "SLOW_CONSUMER");
  assert.equal(overflow.actions.some((action) => action.kind === "close_client"), false);
  now += 4_999;
  assert.equal(core.sweepBackpressure("host-pressure").actions.length, 0);
  now += 1;
  const closed = core.sweepBackpressure("host-pressure");
  assert.equal(closed.actions.some((action) => (
    action.kind === "close_client" && action.closeCode === 1013
  )), true);

  const control = core.drainHostCarrier("host-pressure", { maxFrames: 1 });
  assert.equal(control.length, 1);
  assert.equal(control[0].frame.type, "route.unbind");
  assert.equal(control[0].frame.payload.reason, "slow_consumer");
  assert.equal(control[0].frame.payload.lastClientToHostSeq, "65");
  assert.equal(
    core.drainHostCarrier("host-pressure").some(({ frame }) => frame.type === "route.data"),
    false,
    "unforwarded queued data must be discarded before unbind",
  );

  const hostPressureCore = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  const reverseHost = await registerHost(hostPressureCore, "host-pressure-reverse");
  const reverse = await openRoute(hostPressureCore, "host-pressure-reverse");
  let reverseHigh;
  for (let index = 1; index <= broker.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    reverseHigh = await hostPressureCore.receiveHostFrame(
      "host-pressure-reverse",
      carrierBytes({
        carrierVersion: 1,
        type: "route.data",
        connectorId: reverse.routeOpen.connectorId,
        routeId: reverse.routeOpen.routeId,
        routeFence: reverse.routeOpen.routeFence,
        direction: "host_to_client",
        seq: String(index),
        payload: {
          opcode: "text",
          encoding: "base64",
          data: Buffer.from(publicBytes(hostTerminalAck(`reverse-${index}`))).toString("base64"),
        },
      }),
    );
    assert.equal(reverseHigh.accepted, true);
  }
  assert.equal(reverseHigh.actions.some((action) => (
    action.kind === "pause_host_route"
      && action.connectionIncarnation === reverseHost.connectionIncarnation
  )), true);
  const reverseDeliveries = hostPressureCore.drainClient(reverse.connectionId, { maxFrames: 65 });
  for (let index = 0; index < 64; index += 1) {
    const acknowledged = hostPressureCore.acknowledgeClientDelivery(
      reverse.connectionId,
      reverseDeliveries[index].deliveryId,
    );
    assert.equal(acknowledged.actions.some((action) => action.kind === "resume_host_route"), false);
  }
  const reverseResume = hostPressureCore.acknowledgeClientDelivery(
    reverse.connectionId,
    reverseDeliveries[64].deliveryId,
  );
  assert.equal(reverseResume.actions.some((action) => (
    action.kind === "resume_host_route"
      && action.connectionIncarnation === reverseHost.connectionIncarnation
  )), true);
});

test("backpressure sweep is carrier-scoped and its production batch is hard-bounded", async () => {
  let now = NOW_MS;
  const core = new broker.RelayV2BrokerCore({ now: () => now });
  const transportA = "host-sweep-a";
  const transportB = "host-sweep-b";
  const hostA = "mac-sweep-a";
  const hostB = "mac-sweep-b";
  await registerHost(core, transportA, hostHello({ hostId: hostA }));
  await registerHost(core, transportB, hostHello({ hostId: hostB }));

  const ceiling = broker.RELAY_V2_BROKER_LIMITS.maxRoutesPerCarrier;
  const pressureFrame = clientSweepCapacityFrame();
  const connectionsA = [];
  for (let routeIndex = 0; routeIndex < ceiling - 1; routeIndex += 1) {
    const connectionId = `client-sweep-a-${routeIndex}`;
    connectionsA.push(connectionId);
    await openRoute(core, transportA, connectionId, 1_048_576, hostA);
    let highWater = null;
    for (
      let frameIndex = 0;
      frameIndex < broker.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames;
      frameIndex += 1
    ) {
      const forwarded = core.forwardClientFrame(connectionId, pressureFrame);
      if (forwarded.actions.some((action) => action.kind === "pause_client")) {
        highWater = forwarded;
        break;
      }
      assert.equal(forwarded.accepted, true, `${connectionId} frame ${frameIndex + 1}`);
    }
    assert.ok(highWater, `${connectionId} reaches a bounded pressure fence`);
    assert.equal(highWater.actions.some((action) => action.kind === "pause_client"), true);
  }

  const inFlightA = core.drainHostCarrier(transportA, {
    maxFrames: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(inFlightA.length > 0, "the carrier capacity remains billed in-flight");
  // The frozen id contract admits 128 non-NUL bytes. Their canonical JSON
  // escaping makes this final target's unacknowledged route.open consume the
  // remaining control capacity without inventing a private test frame.
  const wideId = "\u0001".repeat(128);
  const finalOpened = core.openClientRoute(wideId, authContext("client", {
    hostId: hostA,
    principalId: wideId,
    grantId: wideId,
    clientInstanceId: wideId,
    jti: wideId,
    kid: wideId,
  }));
  assert.equal(finalOpened.accepted, true);
  const [finalOpenDelivery] = core.drainHostCarrier(transportA, {
    maxFrames: 1,
    controlOnly: true,
  });
  assert.ok(finalOpenDelivery);
  assert.equal(finalOpenDelivery.frame.type, "route.open");
  assert.equal((await core.receiveHostFrame(transportA, carrierBytes({
    carrierVersion: 1,
    type: "route.opened",
    requestId: finalOpenDelivery.frame.requestId,
    connectorId: finalOpenDelivery.frame.connectorId,
    routeId: finalOpenDelivery.frame.routeId,
    routeFence: finalOpenDelivery.frame.routeFence,
    payload: { acceptedAtMs: now, maxFrameBytes: 1_048_576 },
  }))).accepted, true);
  connectionsA.push(wideId);
  const finalPressure = core.forwardClientFrame(wideId, pressureFrame);
  assert.equal(finalPressure.accepted, false);
  assert.equal(finalPressure.actions.some((action) => action.kind === "pause_client"), true);
  assert.equal(connectionsA.length, ceiling);

  const connectionB = "client-sweep-b";
  await openRoute(core, transportB, connectionB, 1_048_576, hostB);
  let highWaterB = null;
  for (
    let frameIndex = 0;
    frameIndex < broker.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames;
    frameIndex += 1
  ) {
    const forwarded = core.forwardClientFrame(connectionB, pressureFrame);
    if (forwarded.actions.some((action) => action.kind === "pause_client")) {
      highWaterB = forwarded;
      break;
    }
    assert.equal(forwarded.accepted, true);
  }
  assert.ok(highWaterB);
  assert.equal(highWaterB.actions.some((action) => action.kind === "pause_client"), true);

  now += 5_000;
  const sweptA = core.sweepBackpressure(transportA);
  assert.equal(sweptA.accepted, true);
  const admittedUnbinds = core.drainHostCarrier(transportA, {
    maxFrames: Number.MAX_SAFE_INTEGER,
    maxBytes: Number.MAX_SAFE_INTEGER,
    controlOnly: true,
  });
  const dataBytes = inFlightA.reduce((total, delivery) => total + delivery.wire.byteLength, 0);
  const unbindBytes = admittedUnbinds.reduce(
    (total, delivery) => total + delivery.wire.byteLength,
    0,
  );
  assert.ok(
    admittedUnbinds.length < ceiling,
    `route.unbind must exhaust carrier capacity: data=${dataBytes} unbind=${unbindBytes}`,
  );
  assert.equal(
    sweptA.actions.length,
    broker.RELAY_V2_BROKER_LIMITS.maxBackpressureSweepActionsPerCarrier,
    "each route contributes resume plus close, with one carrier close",
  );
  assert.equal(
    sweptA.actions.filter((action) => action.kind === "resume_client").length,
    ceiling,
  );
  assert.equal(
    sweptA.actions.filter((action) => action.kind === "close_client").length,
    ceiling,
  );
  assert.equal(sweptA.actions.filter((action) => action.kind === "close_host").length, 1);
  assert.equal(sweptA.actions.at(-1).kind, "close_host");
  assert.equal(sweptA.actions.at(-1).reason, "carrier_control_backpressure");
  assert.equal(
    sweptA.actions.filter((action) => (
      action.kind === "close_client" || action.kind === "close_host"
    )).length,
    broker.RELAY_V2_BROKER_LIMITS.maxBackpressureSweepMandatoryActionsPerCarrier,
  );
  assert.equal(sweptA.actions.filter((action) => (
    action.kind === "resume_client" || action.kind === "close_client"
  )).every((action) => connectionsA.includes(action.connectionId)), true);
  assert.equal(sweptA.actions.some((action) => action.connectionId === connectionB), false);

  assert.equal(core.sweepBackpressure(transportA).actions.length, 0);
  const sweptB = core.sweepBackpressure(transportB);
  assert.deepEqual(
    sweptB.actions.map((action) => [action.kind, action.connectionId]),
    [["resume_client", connectionB], ["close_client", connectionB]],
  );
});

test("byte pressure resumes only below the frozen 512 KiB low water", async () => {
  const core = new broker.RelayV2BrokerCore({ now: () => NOW_MS });
  await registerHost(core, "host-byte-pressure");
  const { connectionId } = await openRoute(core, "host-byte-pressure");
  const frameBytes = 16_384;
  const frameCount = broker.RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection / frameBytes;
  assert.equal(frameCount, 64);
  let highWater;
  for (let index = 0; index < frameCount; index += 1) {
    highWater = core.forwardClientFrame(
      connectionId,
      clientTerminalInputBytesOfSize(frameBytes, index),
    );
    assert.equal(highWater.accepted, true);
  }
  assert.equal(highWater.actions.some((action) => action.kind === "pause_client"), true);

  const deliveries = core.drainHostCarrier("host-byte-pressure", { maxFrames: 33 });
  assert.equal(deliveries.length, 33);
  for (let index = 0; index < 31; index += 1) {
    const acknowledged = core.acknowledgeHostDelivery(
      "host-byte-pressure",
      deliveries[index].deliveryId,
    );
    assert.equal(acknowledged.actions.some((action) => action.kind === "resume_client"), false);
  }
  const atByteLowWater = core.acknowledgeHostDelivery(
    "host-byte-pressure",
    deliveries[31].deliveryId,
  );
  assert.equal(atByteLowWater.actions.some((action) => action.kind === "resume_client"), false);
  const belowByteLowWater = core.acknowledgeHostDelivery(
    "host-byte-pressure",
    deliveries[32].deliveryId,
  );
  assert.equal(belowByteLowWater.actions.some((action) => action.kind === "resume_client"), true);
});
