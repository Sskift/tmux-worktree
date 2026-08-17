import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const broker = Object.freeze({
  ...brokerModule,
  RelayV2BrokerCore: class G2RelayV2BrokerCore extends brokerModule.RelayV2BrokerCore {
    constructor(options = {}) {
      super({
        baseCapabilityReadiness: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
        ...options,
      });
    }
  },
});
const codec = await import("../dist/relay/v2/codec.js");
const chatCodec = await import("../dist/relay/extensions/agentChat/v2/codec.js");

const HOST_ID = "mac-admin";
const NOW_MS = 1_783_700_000_000;
const SESSION_ID = "session-opaque";

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
  clientDialects = ["tw-relay.v2"],
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

async function registerHost(core, transportId, hello = hostHello()) {
  const hostId = hello.payload.hostId;
  core.attachHostCarrier(transportId, authContext("host", {
    hostId,
    jti: `${transportId}-jti`,
  }), randomUUID());
  const result = await core.receiveHostFrame(transportId, carrierBytes(hello));
  assert.equal(result.accepted, true);
  const registration = result.actions.find((action) => (
    action.kind === "send_host" && action.frame.type === "host.registered"
  ));
  assert.ok(registration);
  const committed = core.acknowledgeHostControlDelivery(transportId, registration.deliveryId);
  assert.equal(committed.accepted, true);
  return {
    hello,
    result: { ...result, actions: [...result.actions, ...committed.actions] },
    registration,
    connectorId: registration.frame.connectorId,
  };
}

async function openRoute(
  core,
  transportId,
  connectionId = randomUUID(),
  openedMaxFrameBytes = 1_048_576,
  hostId = HOST_ID,
  authOverrides = {},
  connectionIncarnation = randomUUID(),
  expectedCapabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
) {
  const opened = core.openClientRoute(connectionId, authContext("client", {
    hostId,
    jti: `${connectionId}-jti`,
    ...authOverrides,
  }), connectionIncarnation);
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
  const [welcomeDelivery] = core.drainClient(connectionId, { maxFrames: 1 });
  assert.ok(welcomeDelivery);
  const welcome = codec.decodeRelayV2WebSocketFrame("public", welcomeDelivery.bytes).frame;
  assert.equal(core.acknowledgeClientDelivery(connectionId, welcomeDelivery.deliveryId).accepted, true);
  return {
    connectionId,
    connectionIncarnation,
    routeOpen,
    acknowledged,
    welcome,
  };
}

function publicBytes(frame) {
  return codec.encodeRelayV2WebSocketFrame("public", frame);
}

function chatBytes(frame) {
  return chatCodec.encodeRelayAgentChatFrame(frame);
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

function hostRouteDataBytes(identity, seq, bytes) {
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
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

function hostWelcome(requestId, host, capabilities) {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "host.welcome",
    requestId,
    hostId: HOST_ID,
    hostEpoch: host.hello.payload.hostEpoch,
    hostInstanceId: host.hello.payload.hostInstanceId,
    payload: {
      selectedVersion: 2,
      capabilities,
      eventSeq: "1",
      resumeDisposition: "snapshot_required",
      resumeReason: "fresh",
      commandDedupeWindow: {
        windowId: "dedupe-window",
        windowSeq: "1",
        acceptUntilMs: NOW_MS + 60_000,
        queryUntilMs: NOW_MS + 120_000,
      },
      limits: {
        commandResultRetentionMs: 86_400_000,
        commandDedupeRetentionMs: 604_800_000,
        maxCommandQueryIds: 32,
        stateSnapshotChunkBytes: 524_288,
        stateSnapshotChunkRecords: 256,
        stateSnapshotMaxBytes: 268_435_456,
        stateSnapshotMaxRecords: 100_000,
        stateSnapshotIdleLeaseMs: 300_000,
        stateSnapshotMaxLifetimeMs: 3_600_000,
        stateSnapshotMaxPinnedPerPrincipal: 2,
        stateSnapshotMaxPinnedPerHost: 16,
        stateSnapshotPinnedBytesPerHost: 536_870_912,
        stateSnapshotPinnedMetadataBytesPerHost: 16_777_216,
        stateSnapshotChunkMaxJsonKeys: 8_192,
        stateSnapshotChunkMaxJsonNodes: 16_384,
        terminalReplayBytesPerStream: 4_194_304,
        terminalReplayBytesPerHost: 67_108_864,
        terminalDetachedLeaseMs: 120_000,
        terminalControlDedupeRetentionMs: 600_000,
        terminalMaxUnackedBytes: 524_288,
        terminalMaxFrameBytes: 65_536,
        terminalInputDedupeEntriesPerStream: 512,
        terminalResizeDedupeEntriesPerStream: 256,
        terminalMaxStreamsPerHost: 256,
        terminalControlRecordsPerHost: 4_096,
        brokerRouteBufferedBytesPerDirection: 1_048_576,
        brokerRouteLowWaterBytesPerDirection: 524_288,
      },
    },
  };
}

// --- agent.chat frame builders -------------------------------------------------

function chatSend(requestId, hostEpoch, sessionId, message, settings) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.send",
    requestId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: {
      session: sessionId,
      message,
      ...(settings === undefined ? {} : { settings }),
    },
  };
}

function chatHistory(requestId, hostEpoch, sessionId, limit) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.history",
    requestId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: limit === undefined
      ? { session: sessionId }
      : { session: sessionId, limit },
  };
}

function chatImageGet(requestId, hostEpoch, sessionId, imageId, offset = 0) {
  return {
    protocolVersion: 2,
    kind: "request",
    type: "agent.chat.image.get",
    requestId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: { session: sessionId, imageId, offset },
  };
}

function chatSent(requestId, hostEpoch, sessionId, turnId) {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "agent.chat.sent",
    requestId,
    hostId: HOST_ID,
    hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: { session: sessionId, turnId },
  };
}

function chatEvent(hostEpoch, sessionId, turn) {
  return {
    protocolVersion: 2,
    kind: "event",
    type: "agent.chat.event",
    hostId: HOST_ID,
    hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: { session: sessionId, turn },
  };
}

function chatHistoryResult(requestId, hostEpoch, sessionId, turns) {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "agent.chat.history.result",
    requestId,
    hostId: HOST_ID,
    hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: { session: sessionId, turns },
  };
}

function chatImageChunk(requestId, hostEpoch, sessionId, sha256, data) {
  const imageId = `image-${sha256}`;
  return {
    protocolVersion: 2,
    kind: "response",
    type: "agent.chat.image.chunk",
    requestId,
    hostId: HOST_ID,
    hostEpoch,
    scopeId: "scope-local",
    sessionId,
    payload: {
      session: sessionId,
      imageId,
      mimeType: "image/png",
      byteLength: data.byteLength,
      sha256,
      offset: 0,
      dataBase64: data.toString("base64"),
      nextOffset: null,
    },
  };
}

function markdownContent(text) {
  return [{ type: "markdown", text }];
}

function chatTurn({
  turnId = "turn-1",
  session = SESSION_ID,
  userMessage = "list current worktrees",
  status = "working",
  content = null,
  progress = [],
  error = null,
  completedAt = null,
  steeredMessages = null,
  sentAt = "2026-08-06T00:00:00.000Z",
} = {}) {
  return {
    turnId,
    session,
    userMessage,
    status,
    content,
    progress,
    error,
    completedAt,
    steeredMessages,
    sentAt,
  };
}

// --- codec round-trip -----------------------------------------------------------

test("Node agent.chat.v2 codec round-trips every wire type", () => {
  const hostEpoch = randomUUID();
  const imageSha256 = "a".repeat(64);
  const imageBytes = Buffer.from("png-test-chunk", "utf8");
  const frames = [
    chatSend("req-send", hostEpoch, SESSION_ID, "list worktrees"),
    chatHistory("req-history", hostEpoch, SESSION_ID),
    chatHistory("req-history-limit", hostEpoch, SESSION_ID, 10),
    chatImageGet("req-image", hostEpoch, SESSION_ID, `image-${imageSha256}`),
    chatSent("req-send", hostEpoch, SESSION_ID, "turn-1"),
    chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "working",
    })),
    chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "replied",
      content: markdownContent("Here are the worktrees."),
      completedAt: "2026-08-06T00:00:01.000Z",
    })),
    chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "failed",
      error: "relay-host crashed",
      completedAt: "2026-08-06T00:00:01.000Z",
    })),
    chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "recovery-required",
      error: "session lost",
      completedAt: "2026-08-06T00:00:01.000Z",
    })),
    chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "replied",
      content: markdownContent("Done."),
      completedAt: "2026-08-06T00:00:01.000Z",
      steeredMessages: [
        { message: "finish the turn", sentAt: "2026-08-06T00:00:00.100Z" },
      ],
    })),
    chatHistoryResult("req-history", hostEpoch, SESSION_ID, [
      chatTurn({ status: "working" }),
      chatTurn({
        status: "replied",
        content: markdownContent("Here."),
        completedAt: "2026-08-06T00:00:01.000Z",
      }),
    ]),
    chatImageChunk("req-image", hostEpoch, SESSION_ID, imageSha256, imageBytes),
  ];
  for (const frame of frames) {
    const bytes = chatBytes(frame);
    const decoded = chatCodec.decodeRelayAgentChatFrame(bytes);
    assert.equal(decoded.normalized.channel, "public");
    assert.equal(decoded.normalized.version, 2);
    assert.equal(decoded.normalized.capability, "agent.chat.v2");
    assert.equal(decoded.normalized.type, frame.type);
    assert.deepEqual(JSON.parse(decoded.canonicalWire), frame);
    assert.deepEqual(Buffer.from(chatCodec.encodeRelayAgentChatFrame(decoded.frame)), Buffer.from(bytes));
  }
});

test("Node agent.chat.v2 codec rejects turn state inconsistency and unknown types", () => {
  const hostEpoch = randomUUID();
  const invalid = [
    ["working with content", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "working",
      content: markdownContent("should not exist"),
    })), "INVALID_ENVELOPE"],
    ["working with completedAt", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "working",
      completedAt: "2026-08-06T00:00:01.000Z",
    })), "INVALID_ENVELOPE"],
    ["replied without content", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "replied",
      completedAt: "2026-08-06T00:00:01.000Z",
    })), "INVALID_ENVELOPE"],
    ["replied with error", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "replied",
      content: markdownContent("ok"),
      error: "boom",
      completedAt: "2026-08-06T00:00:01.000Z",
    })), "INVALID_ENVELOPE"],
    ["failed without error", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "failed",
      completedAt: "2026-08-06T00:00:01.000Z",
    })), "INVALID_ENVELOPE"],
    ["failed with content", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "failed",
      content: markdownContent("partial"),
      error: "boom",
      completedAt: "2026-08-06T00:00:01.000Z",
    })), "INVALID_ENVELOPE"],
    ["working with steered messages", chatEvent(hostEpoch, SESSION_ID, chatTurn({
      status: "working",
      steeredMessages: [{ message: "hi", sentAt: "2026-08-06T00:00:00.000Z" }],
    })), "INVALID_ENVELOPE"],
    ["unknown message type", {
      protocolVersion: 2,
      kind: "request",
      type: "agent.chat.nope",
      requestId: "req-x",
      hostId: HOST_ID,
      expectedHostEpoch: hostEpoch,
      scopeId: "scope-local",
      sessionId: SESSION_ID,
      payload: {},
    }, "INVALID_ENVELOPE"],
    ["missing scopeId", {
      ...chatSend("req-s", hostEpoch, SESSION_ID, "hi"),
      scopeId: undefined,
    }, "INVALID_ENVELOPE"],
    ["payload null for send", {
      ...chatSend("req-s", hostEpoch, SESSION_ID, "hi"),
      payload: null,
    }, "INVALID_ENVELOPE"],
  ];
  for (const [name, frame, expectedCode] of invalid) {
    const bytes = Buffer.from(JSON.stringify(frame), "utf8");
    assert.throws(
      () => chatCodec.decodeRelayAgentChatFrame(bytes),
      (error) => chatCodec.relayAgentChatCodecFailure(error)?.code === expectedCode,
      name,
    );
  }
});

test("Node agent.chat.v2 unavailable error envelope is encodable", () => {
  const bytes = chatCodec.encodeRelayAgentChatUnavailableError({
    requestId: "req-u",
    hostId: HOST_ID,
    hostEpoch: "epoch-1",
    scopeId: "scope-local",
    sessionId: SESSION_ID,
    code: "AGENT_CHAT_UNAVAILABLE",
    message: "The Relay Agent chat request cannot be satisfied",
    retryable: true,
  });
  const decoded = chatCodec.decodeRelayAgentChatFrame(bytes);
  assert.equal(decoded.frame.type, "error");
  assert.equal(decoded.frame.payload, null);
  assert.equal(decoded.frame.error.code, "AGENT_CHAT_UNAVAILABLE");
  assert.equal(decoded.frame.error.commandDisposition, "not_applicable");
  assert.equal(decoded.frame.error.retryable, true);
});

// --- broker three-party gating ----------------------------------------------------

test("agent.chat.v2 is a three-party route intersection with isolated withdrawal", async () => {
  const baseCapabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  const chatCapability = chatCodec.RELAY_AGENT_CHAT_CAPABILITY;
  const claimedCapabilities = [...baseCapabilities, chatCapability];
  assert.ok(brokerModule.RELAY_V2_OPTIONAL_CAPABILITIES.includes(chatCapability));

  // Default-off: host advertisement is stripped and the route never opens.
  const disabled = new brokerModule.RelayV2BrokerCore({
    now: () => NOW_MS,
    optionalCapabilityReadiness: [chatCapability],
  });
  await registerHost(disabled, "chat-host-disabled", hostHello({
    capabilities: claimedCapabilities,
  }));
  assert.deepEqual(disabled.inspectHost(HOST_ID).capabilities, []);
  const disabledRoute = disabled.openClientRoute(
    "client-chat-disabled",
    authContext("client"),
  );
  assert.equal(disabledRoute.accepted, false);
  assert.equal(disabledRoute.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(disabled.drainClient("client-chat-disabled").length, 0);

  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    baseCapabilityReadiness: baseCapabilities,
    optionalCapabilityReadiness: [chatCapability],
  });
  const host = await registerHost(core, "chat-host", hostHello({
    capabilities: claimedCapabilities,
  }));
  assert.deepEqual(
    core.readHostsSnapshot(authContext("client"), "hosts-chat-direct")
      .payload.items[0].capabilities,
    claimedCapabilities,
  );

  // Negotiated route: client.hello offers chat, host.welcome keeps it.
  const route = await openRoute(
    core,
    "chat-host",
    "client-chat",
    1_048_576,
    HOST_ID,
    {},
    randomUUID(),
    claimedCapabilities,
  );
  const selectedHello = clientHello("hello-chat");
  selectedHello.payload.capabilities = claimedCapabilities;
  selectedHello.payload.requiredCapabilities = baseCapabilities;
  assert.equal(core.forwardClientFrame(
    route.connectionId,
    publicBytes(selectedHello),
  ).accepted, true);
  const [selectedHelloDelivery] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  core.acknowledgeHostDelivery("chat-host", selectedHelloDelivery.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(
      route.routeOpen,
      "1",
      publicBytes(hostWelcome("hello-chat", host, claimedCapabilities)),
    )),
  )).accepted, true);
  const [selectedWelcomeDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.deepEqual(
    codec.decodeRelayV2WebSocketFrame("public", selectedWelcomeDelivery.bytes)
      .frame.payload.capabilities,
    claimedCapabilities,
  );
  core.acknowledgeClientDelivery(route.connectionId, selectedWelcomeDelivery.deliveryId);

  const hostEpoch = host.hello.payload.hostEpoch;

  // A new client cannot smuggle configured sends through a legacy chat-only
  // intersection, and the ordinary agent.chat.v2 lane remains usable.
  const configuredWithoutMarker = chatSend(
    "chat-send-configured-old-host",
    hostEpoch,
    SESSION_ID,
    "plan this",
    { model: "gpt-5.6-sol", reasoningEffort: "high", mode: "plan" },
  );
  const rejectedConfigured = core.forwardClientFrame(
    route.connectionId,
    chatBytes(configuredWithoutMarker),
  );
  assert.equal(rejectedConfigured.accepted, false);
  assert.equal(rejectedConfigured.error.code, "INVALID_ENVELOPE");

  // agent.chat.send client→host is relayed through the extension lane.
  const sendFrame = chatSend("chat-send-1", hostEpoch, SESSION_ID, "list current worktrees");
  assert.equal(core.forwardClientFrame(route.connectionId, chatBytes(sendFrame)).accepted, true);
  const [sendDelivery] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  assert.equal(sendDelivery.frame.type, "route.data");
  assert.deepEqual(
    JSON.parse(chatCodec.decodeRelayAgentChatFrame(
      Buffer.from(sendDelivery.frame.payload.data, "base64"),
    ).canonicalWire),
    sendFrame,
  );
  core.acknowledgeHostDelivery("chat-host", sendDelivery.deliveryId);

  // agent.chat.sent host→client is delivered.
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(
      route.routeOpen,
      "2",
      chatBytes(chatSent("chat-send-1", hostEpoch, SESSION_ID, "turn-1")),
    )),
  )).accepted, true);
  const [sentDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.equal(
    chatCodec.decodeRelayAgentChatFrame(Buffer.from(sentDelivery.bytes)).frame.type,
    "agent.chat.sent",
  );
  core.acknowledgeClientDelivery(route.connectionId, sentDelivery.deliveryId);

  // agent.chat.event host→client is delivered.
  const eventFrame = chatEvent(hostEpoch, SESSION_ID, chatTurn({
    status: "replied",
    content: markdownContent("Here are the worktrees."),
    completedAt: "2026-08-06T00:00:01.000Z",
  }));
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(route.routeOpen, "3", chatBytes(eventFrame))),
  )).accepted, true);
  const [eventDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.equal(
    chatCodec.decodeRelayAgentChatFrame(Buffer.from(eventDelivery.bytes)).frame.type,
    "agent.chat.event",
  );
  core.acknowledgeClientDelivery(route.connectionId, eventDelivery.deliveryId);

  // agent.chat.history client→host and history.result host→client.
  const historyFrame = chatHistory("chat-history-1", hostEpoch, SESSION_ID, 10);
  assert.equal(core.forwardClientFrame(route.connectionId, chatBytes(historyFrame)).accepted, true);
  const [historyDelivery] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  core.acknowledgeHostDelivery("chat-host", historyDelivery.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(
      route.routeOpen,
      "4",
      chatBytes(chatHistoryResult("chat-history-1", hostEpoch, SESSION_ID, [])),
    )),
  )).accepted, true);
  const [resultDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.equal(
    chatCodec.decodeRelayAgentChatFrame(Buffer.from(resultDelivery.bytes)).frame.type,
    "agent.chat.history.result",
  );
  core.acknowledgeClientDelivery(route.connectionId, resultDelivery.deliveryId);

  // Image chunks use the same negotiated v2 chat lane in both directions.
  const imageData = Buffer.from("89504e470d0a1a0a", "hex");
  const imageSha256 = createHash("sha256").update(imageData).digest("hex");
  const imageGetFrame = chatImageGet(
    "chat-image-1",
    hostEpoch,
    SESSION_ID,
    `image-${imageSha256}`,
  );
  assert.equal(core.forwardClientFrame(
    route.connectionId,
    chatBytes(imageGetFrame),
  ).accepted, true);
  const [imageGetDelivery] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  assert.equal(
    chatCodec.decodeRelayAgentChatFrame(
      Buffer.from(imageGetDelivery.frame.payload.data, "base64"),
    ).frame.type,
    "agent.chat.image.get",
  );
  core.acknowledgeHostDelivery("chat-host", imageGetDelivery.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(
      route.routeOpen,
      "5",
      chatBytes(chatImageChunk(
        "chat-image-1",
        hostEpoch,
        SESSION_ID,
        imageSha256,
        imageData,
      )),
    )),
  )).accepted, true);
  const [imageChunkDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.equal(
    chatCodec.decodeRelayAgentChatFrame(Buffer.from(imageChunkDelivery.bytes)).frame.type,
    "agent.chat.image.chunk",
  );
  core.acknowledgeClientDelivery(route.connectionId, imageChunkDelivery.deliveryId);

  // Non-offering client: the host.welcome is filtered and a chat frame is rejected.
  const noOfferRoute = await openRoute(
    core,
    "chat-host",
    "client-chat-no-offer",
    1_048_576,
    HOST_ID,
    {},
    randomUUID(),
    baseCapabilities,
  );
  const noOfferHello = clientHello("hello-chat-no-offer");
  noOfferHello.payload.capabilities = baseCapabilities;
  noOfferHello.payload.requiredCapabilities = baseCapabilities;
  assert.equal(core.forwardClientFrame(
    noOfferRoute.connectionId,
    publicBytes(noOfferHello),
  ).accepted, true);
  const [noOfferHelloDelivery] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  core.acknowledgeHostDelivery("chat-host", noOfferHelloDelivery.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes(hostRouteDataBytes(
      noOfferRoute.routeOpen,
      "1",
      publicBytes(hostWelcome("hello-chat-no-offer", host, claimedCapabilities)),
    )),
  )).accepted, true);
  const [noOfferWelcomeDelivery] = core.drainClient(noOfferRoute.connectionId, { maxFrames: 1 });
  assert.deepEqual(
    codec.decodeRelayV2WebSocketFrame("public", noOfferWelcomeDelivery.bytes)
      .frame.payload.capabilities,
    baseCapabilities,
  );
  core.acknowledgeClientDelivery(noOfferRoute.connectionId, noOfferWelcomeDelivery.deliveryId);
  const noOfferChat = chatSend("chat-no-offer-1", hostEpoch, SESSION_ID, "hi");
  const noOfferViolation = core.forwardClientFrame(noOfferRoute.connectionId, chatBytes(noOfferChat));
  assert.equal(noOfferViolation.accepted, false);
  assert.equal(noOfferViolation.error.code, "INVALID_ENVELOPE");
  assert.equal(noOfferViolation.actions.some((action) => (
    action.kind === "close_client" && action.closeCode === 4400
  )), true);
  assert.equal(core.drainClient(noOfferRoute.connectionId).length, 0);
  const [noOfferUnbind] = core.drainHostCarrier("chat-host", { maxFrames: 1 });
  assert.equal(noOfferUnbind.frame.type, "route.unbind");
  core.acknowledgeHostDelivery("chat-host", noOfferUnbind.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "chat-host",
    carrierBytes({
      carrierVersion: 1,
      type: "route.unbound",
      connectorId: noOfferUnbind.frame.connectorId,
      routeId: noOfferUnbind.frame.routeId,
      routeFence: noOfferUnbind.frame.routeFence,
      payload: {
        reason: noOfferUnbind.frame.payload.reason,
        lastClientToHostSeq: noOfferUnbind.frame.payload.lastClientToHostSeq,
        lastHostToClientSeq: "1",
      },
    }),
  )).accepted, true);

  // Withdrawal: directory loses the capability and a negotiated route gets
  // an isolated AGENT_CHAT_UNAVAILABLE error frame instead of a protocol error.
  const withdrawn = core.optionalCapabilityReadinessPort.withdraw(chatCapability);
  assert.deepEqual(withdrawn, { accepted: true, actions: [] });
  assert.deepEqual(core.inspectHost(HOST_ID).capabilities, baseCapabilities);
  const afterWithdraw = core.forwardClientFrame(
    route.connectionId,
    chatBytes(chatSend("chat-after-withdraw", hostEpoch, SESSION_ID, "hi")),
  );
  assert.equal(afterWithdraw.accepted, true);
  const [unavailableDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  assert.ok(unavailableDelivery);
  const unavailable = chatCodec.decodeRelayAgentChatFrame(
    Buffer.from(unavailableDelivery.bytes),
  ).frame;
  assert.equal(unavailable.type, "error");
  assert.equal(unavailable.error.code, "AGENT_CHAT_UNAVAILABLE");
  assert.equal(unavailable.error.commandDisposition, "not_applicable");
  assert.equal(unavailable.error.retryable, true);
  core.acknowledgeClientDelivery(route.connectionId, unavailableDelivery.deliveryId);
});

test("configured agent chat send requires and honors the runtime-settings marker", async () => {
  const baseCapabilities = [...broker.RELAY_V2_REQUIRED_CAPABILITIES];
  const chatCapability = chatCodec.RELAY_AGENT_CHAT_CAPABILITY;
  const runtimeCapability = chatCodec.RELAY_AGENT_CHAT_RUNTIME_SETTINGS_CAPABILITY;
  const capabilities = [...baseCapabilities, chatCapability, runtimeCapability];
  const core = new broker.RelayV2BrokerCore({
    now: () => NOW_MS,
    baseCapabilityReadiness: baseCapabilities,
    optionalCapabilityReadiness: [chatCapability, runtimeCapability],
  });
  const host = await registerHost(core, "configured-chat-host", hostHello({ capabilities }));
  const route = await openRoute(
    core,
    "configured-chat-host",
    "configured-chat-client",
    1_048_576,
    HOST_ID,
    {},
    randomUUID(),
    capabilities,
  );
  const hello = clientHello("hello-configured-chat");
  hello.payload.capabilities = capabilities;
  hello.payload.requiredCapabilities = baseCapabilities;
  assert.equal(core.forwardClientFrame(route.connectionId, publicBytes(hello)).accepted, true);
  const [helloDelivery] = core.drainHostCarrier("configured-chat-host", { maxFrames: 1 });
  core.acknowledgeHostDelivery("configured-chat-host", helloDelivery.deliveryId);
  assert.equal((await core.receiveHostFrame(
    "configured-chat-host",
    carrierBytes(hostRouteDataBytes(
      route.routeOpen,
      "1",
      publicBytes(hostWelcome("hello-configured-chat", host, capabilities)),
    )),
  )).accepted, true);
  const [welcomeDelivery] = core.drainClient(route.connectionId, { maxFrames: 1 });
  core.acknowledgeClientDelivery(route.connectionId, welcomeDelivery.deliveryId);

  const configured = chatSend(
    "configured-send-1",
    host.hello.payload.hostEpoch,
    SESSION_ID,
    "plan this",
    { model: "gpt-5.6-terra", reasoningEffort: "high", mode: "plan" },
  );
  assert.equal(core.forwardClientFrame(route.connectionId, chatBytes(configured)).accepted, true);
  const [configuredDelivery] = core.drainHostCarrier("configured-chat-host", { maxFrames: 1 });
  assert.deepEqual(
    JSON.parse(chatCodec.decodeRelayAgentChatFrame(
      Buffer.from(configuredDelivery.frame.payload.data, "base64"),
    ).canonicalWire),
    configured,
  );
});
