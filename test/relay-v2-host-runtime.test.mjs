import assert from "node:assert/strict";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const broker = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const runtimeModule = await import("../dist/relay/v2/hostRuntime.js");

const corpus = loadRelayV2FixtureCorpus();
const HOST_ID = "mac-admin";
const HOST_EPOCH = "authority-uuid";
const HOST_INSTANCE_ID = "host-process-uuid";

function fixture(name) {
  return structuredClone(corpus.goldenByName.get(name).frame);
}

function capabilityIntersection(overrides = {}) {
  return Object.fromEntries(broker.RELAY_V2_REQUIRED_CAPABILITIES.map((capability) => [
    capability,
    overrides[capability] ?? true,
  ]));
}

function binding(overrides = {}) {
  return Object.freeze({
    connectorGeneration: 1,
    connectorId: "connector-one",
    routeId: "route-one",
    routeFence: "fence-one",
    connectionId: "connection-one",
    clientDialect: "tw-relay.v2",
    maxFrameBytes: 1_048_576,
    authContext: Object.freeze({
      scheme: "twcap2",
      role: "client",
      hostId: HOST_ID,
      principalId: "principal-one",
      grantId: "grant-one",
      clientInstanceId: "android-one",
      jti: "jti-one",
      kid: "kid-one",
      expiresAtMs: 1_783_703_600_000,
      ...(overrides.authContext ?? {}),
    }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "authContext")),
  });
}

function errorResponse(request, code = "BUSY") {
  return {
    protocolVersion: 2,
    kind: "response",
    type: "error",
    requestId: request.requestId,
    ...(request.commandId ? { commandId: request.commandId } : {}),
    ...(request.hostId ? { hostId: request.hostId } : {}),
    hostEpoch: HOST_EPOCH,
    ...(request.scopeId ? { scopeId: request.scopeId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.streamId ? { streamId: request.streamId } : {}),
    payload: null,
    error: {
      code,
      message: "fake authority response",
      retryable: code === "BUSY",
      retryAfterMs: code === "BUSY" ? 0 : null,
      commandDisposition: request.type === "command.execute"
        ? "not_accepted"
        : "not_applicable",
      details: null,
    },
  };
}

function hostWelcome(request) {
  const welcome = fixture("host-welcome-snapshot-required");
  welcome.requestId = request.requestId;
  welcome.hostId = HOST_ID;
  welcome.hostEpoch = request.hostEpoch;
  welcome.hostInstanceId = request.hostInstanceId;
  welcome.payload.capabilities = [...request.capabilities];
  return welcome;
}

function createHarness(options = {}) {
  const state = {
    identity: {
      hostEpoch: HOST_EPOCH,
      hostInstanceId: HOST_INSTANCE_ID,
    },
    capabilities: capabilityIntersection(options.capabilityOverrides),
    calls: {
      commandExecute: [],
      commandQuery: [],
      hello: [],
      scopes: [],
      sessions: [],
      snapshotGet: [],
      snapshotRelease: [],
      terminal: [],
      unbind: [],
      unsubscribe: [],
    },
    sent: [],
    closes: [],
  };
  const commands = {
    async execute(auth, frame) {
      state.calls.commandExecute.push({ auth: structuredClone(auth), frame: structuredClone(frame) });
      if (options.execute) return options.execute(auth, frame);
      return errorResponse(frame);
    },
    async query(auth, frame) {
      state.calls.commandQuery.push({ auth: structuredClone(auth), frame: structuredClone(frame) });
      if (options.query) return options.query(auth, frame);
      return errorResponse(frame);
    },
  };
  const resources = {
    async hello(request, sink) {
      state.calls.hello.push(structuredClone(request));
      if (options.hello) return options.hello(request, sink);
      assert.equal(sink.enqueue(hostWelcome(request)), true);
    },
    async scopesSnapshot(request) {
      state.calls.scopes.push(structuredClone(request));
      return options.scopesSnapshot?.(request) ?? errorResponse(request);
    },
    async sessionsSnapshot(request) {
      state.calls.sessions.push(structuredClone(request));
      return options.sessionsSnapshot?.(request) ?? errorResponse(request);
    },
    async stateSnapshotGet(request) {
      state.calls.snapshotGet.push(structuredClone(request));
      return options.stateSnapshotGet?.(request) ?? errorResponse(request);
    },
    async stateSnapshotRelease(request) {
      state.calls.snapshotRelease.push(structuredClone(request));
      return options.stateSnapshotRelease?.(request) ?? errorResponse(request);
    },
    unsubscribe(subscriberId) {
      state.calls.unsubscribe.push(subscriberId);
    },
  };
  const terminals = Object.fromEntries([
    "open",
    "requestReplay",
    "acknowledgeOutput",
    "input",
    "resize",
    "close",
  ].map((method) => [method, async (request) => {
    state.calls.terminal.push({ method, request: structuredClone(request) });
    return options.terminal?.(method, request);
  }]));
  terminals.unbind = async (auth, route) => {
    state.calls.unbind.push({ auth: structuredClone(auth), route: structuredClone(route) });
  };
  const outbound = {
    trySend(routeBinding, bytes) {
      const frame = codec.decodeRelayV2WebSocketFrame("public", bytes).frame;
      state.sent.push({ binding: routeBinding, frame });
      return options.trySend?.(routeBinding, bytes, frame) ?? true;
    },
    close(routeBinding, reason) {
      state.closes.push({ binding: routeBinding, reason });
    },
  };
  const runtime = new runtimeModule.RelayV2HostRuntime({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    identity: {
      current: options.currentIdentity ?? (async () => structuredClone(state.identity)),
    },
    capabilityIntersection: {
      current: () => structuredClone(state.capabilities),
    },
    commands,
    resources,
    terminals,
    outbound,
    testLimits: options.testLimits,
  });
  return { runtime, state, commands, resources, terminals, outbound };
}

function send(runtime, routeBinding, frame) {
  const bytes = codec.encodeRelayV2WebSocketFrame("public", frame);
  runtime.onClientFrame(routeBinding, bytes);
}

async function settle(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function ready(harness, routeBinding = binding()) {
  harness.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.hostId = HOST_ID;
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(harness.runtime, routeBinding, hello);
  await settle();
  assert.equal(harness.state.sent.at(-1).frame.type, "host.welcome");
  return routeBinding;
}

test("host runtime dispatches strict public requests only to their H1, H2, and H3 owners", async () => {
  const h = createHarness();
  const routeBinding = await ready(h);

  const frames = [
    fixture("command-execute-send-agent-message"),
    fixture("command-query"),
    fixture("scopes-snapshot-get"),
    fixture("sessions-snapshot-get-all"),
    fixture("state-snapshot-get-first"),
    fixture("state-snapshot-release"),
    fixture("terminal-open-new"),
    fixture("terminal-replay-request"),
    fixture("terminal-output-ack"),
    fixture("terminal-input"),
    fixture("terminal-resize"),
    fixture("terminal-close"),
  ];
  for (const frame of frames) {
    if (Object.hasOwn(frame, "hostId")) frame.hostId = HOST_ID;
    if (Object.hasOwn(frame, "expectedHostEpoch")) frame.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, frame);
  }
  await settle(8);

  assert.equal(h.state.calls.commandExecute.length, 1);
  assert.equal(h.state.calls.commandQuery.length, 1);
  assert.equal(h.state.calls.scopes.length, 1);
  assert.equal(h.state.calls.sessions.length, 1);
  assert.equal(h.state.calls.snapshotGet.length, 1);
  assert.equal(h.state.calls.snapshotRelease.length, 1);
  assert.deepEqual(
    h.state.calls.terminal.map(({ method }) => method),
    ["open", "requestReplay", "acknowledgeOutput", "input", "resize", "close"],
  );
  assert.deepEqual(h.state.calls.commandExecute[0].auth, {
    principalId: "principal-one",
    clientInstanceId: "android-one",
    hostId: HOST_ID,
  });
  assert.deepEqual(h.state.calls.snapshotGet[0], {
    requestId: frames[4].requestId,
    expectedHostEpoch: HOST_EPOCH,
    principalId: "principal-one",
    clientInstanceId: "android-one",
    snapshotRequestId: frames[4].payload.snapshotRequestId,
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  assert.ok(h.state.sent.slice(1).every(({ frame }) => frame.type === "error"));
  assert.equal(h.state.closes.length, 0);
});

test("auth, current host epoch, and exact carrier binding reject stale frames before side effects", async (t) => {
  await t.test("binding auth and connector generation are immutable", async () => {
    const h = createHarness();
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;

    const staleBindings = [
      { ...routeBinding, connectorGeneration: 2 },
      { ...routeBinding, connectorId: "stale-connector" },
      { ...routeBinding, routeId: "stale-route" },
      { ...routeBinding, routeFence: "stale-fence" },
      { ...routeBinding, connectionId: "stale-connection" },
      { ...routeBinding, maxFrameBytes: routeBinding.maxFrameBytes - 1 },
      {
        ...routeBinding,
        authContext: { ...routeBinding.authContext, role: "host" },
      },
      {
        ...routeBinding,
        authContext: { ...routeBinding.authContext, hostId: "forged-host" },
      },
      {
        ...routeBinding,
        authContext: { ...routeBinding.authContext, principalId: "forged-principal" },
      },
      {
        ...routeBinding,
        authContext: { ...routeBinding.authContext, clientInstanceId: "forged-client" },
      },
    ];
    for (const stale of staleBindings) send(h.runtime, stale, command);
    await settle();
    assert.equal(h.state.calls.commandExecute.length, 0);
  });

  await t.test("host epoch mismatch is correlated before H1", async () => {
    const h = createHarness();
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = "stale-host-epoch";
    send(h.runtime, routeBinding, command);
    await settle();

    assert.equal(h.state.calls.commandExecute.length, 0);
    const response = h.state.sent.at(-1).frame;
    assert.equal(response.type, "error");
    assert.equal(response.requestId, command.requestId);
    assert.equal(response.error.code, "HOST_EPOCH_MISMATCH");
    assert.deepEqual({ ...response.error.details }, {
      expectedHostEpoch: "stale-host-epoch",
      actualHostEpoch: HOST_EPOCH,
    });
    assert.equal(h.state.closes.at(-1).reason, "protocol_error");
  });

  await t.test("an H0 lineage change fences the old route before H1", async () => {
    const h = createHarness();
    const routeBinding = await ready(h);
    h.state.identity.hostEpoch = "replacement-host-epoch";
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle();

    assert.equal(h.state.calls.commandExecute.length, 0);
    const response = h.state.sent.at(-1).frame;
    assert.equal(response.error.code, "HOST_EPOCH_MISMATCH");
    assert.equal(response.hostEpoch, "replacement-host-epoch");
    assert.equal(response.error.details.actualHostEpoch, "replacement-host-epoch");
  });

  await t.test("client identity mismatch never enters the hello authority", async () => {
    const h = createHarness();
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = "forged-client";
    send(h.runtime, routeBinding, hello);
    await settle();
    assert.equal(h.state.calls.hello.length, 0);
    assert.equal(h.state.sent[0].frame.error.code, "PERMISSION_DENIED");
  });
});

test("unbind fences queued work and late authority callbacks from every replacement binding", async () => {
  let resolveCommand;
  const result = new Promise((resolve) => { resolveCommand = resolve; });
  const h = createHarness({ execute: async () => result });
  const first = await ready(h);
  const command = fixture("command-execute-send-agent-message");
  command.expectedHostEpoch = HOST_EPOCH;
  send(h.runtime, first, command);
  await settle(2);
  assert.equal(h.state.calls.commandExecute.length, 1);

  h.runtime.onRouteUnbound(first, "client_replaced");
  const second = binding({
    connectorGeneration: 2,
    connectorId: "connector-two",
    routeId: first.routeId,
    routeFence: "fence-two",
    connectionId: "connection-two",
    authContext: { jti: "jti-two" },
  });
  await ready(h, second);
  const sentBeforeLateResult = h.state.sent.length;
  resolveCommand(errorResponse(command));
  await settle(6);

  assert.equal(h.state.sent.length, sentBeforeLateResult);
  assert.equal(h.state.calls.unsubscribe.includes("host-route-1"), true);
  assert.equal(h.state.calls.unbind.length >= 1, true);
  const oldAuthorityRoute = h.state.calls.unbind[0].route;
  await assert.rejects(
    h.runtime.sendTerminalFrame(oldAuthorityRoute, fixture("terminal-input-ack")),
    /stale route binding/,
  );
});

test("the six-capability intersection has no optimistic default and gates mutation and terminal admission", async () => {
  const h = createHarness({
    capabilityOverrides: { "terminal.stream.resume.v1": false },
  });
  assert.deepEqual(h.runtime.advertisedCapabilities(), []);
  const routeBinding = binding();
  h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle();

  assert.equal(h.state.calls.hello.length, 0);
  assert.equal(h.state.sent[0].frame.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(h.state.closes.at(-1).reason, "protocol_error");
  assert.equal(h.state.calls.commandExecute.length, 0);
  assert.equal(h.state.calls.terminal.length, 0);

  h.state.capabilities["terminal.stream.resume.v1"] = true;
  assert.deepEqual(
    h.runtime.advertisedCapabilities(),
    [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  );
});

test("per-route request and outbound capacity return BUSY or SLOW_CONSUMER without unbounded queues", async (t) => {
  await t.test("unfinished request capacity returns a correlated BUSY response", async () => {
    let releaseIdentity;
    let holdIdentity = false;
    const gate = new Promise((resolve) => { releaseIdentity = resolve; });
    const h = createHarness({
      testLimits: { maxInFlightRequestsPerRoute: 1 },
      currentIdentity: async () => {
        if (holdIdentity) await gate;
        return { hostEpoch: HOST_EPOCH, hostInstanceId: HOST_INSTANCE_ID };
      },
    });
    const routeBinding = await ready(h);
    holdIdentity = true;
    const first = fixture("command-query");
    first.requestId = "query-capacity-one";
    first.expectedHostEpoch = HOST_EPOCH;
    const second = structuredClone(first);
    second.requestId = "query-capacity-two";
    send(h.runtime, routeBinding, first);
    send(h.runtime, routeBinding, second);
    await settle(2);

    const busy = h.state.sent.find(({ frame }) => frame.requestId === second.requestId)?.frame;
    assert.equal(busy.error.code, "BUSY");
    assert.equal(busy.error.retryable, true);
    assert.equal(h.state.calls.commandQuery.length, 0);
    releaseIdentity();
    await settle(6);
    assert.equal(h.state.calls.commandQuery.length, 1);
  });

  await t.test("outbound frame saturation closes the exact route as a slow consumer", async () => {
    const never = new Promise(() => {});
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      trySend: () => never,
      hello: async (request, sink) => {
        assert.equal(sink.enqueue(hostWelcome(request)), true);
        const event = fixture("sessions-changed-upsert");
        event.hostId = HOST_ID;
        event.hostEpoch = HOST_EPOCH;
        if (!sink.enqueue(event)) {
          const error = new Error("bounded H2 subscriber rejected event");
          error.code = "BUSY";
          throw error;
        }
      },
    });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await settle(6);
    assert.deepEqual(h.state.closes.at(-1).binding, routeBinding);
    assert.equal(h.state.closes.at(-1).reason, "slow_consumer");
  });
});

test("correlated responses return only to the originating exact binding", async () => {
  const pending = new Map();
  const h = createHarness({
    query: async (_auth, frame) => new Promise((resolve) => {
      pending.set(frame.requestId, () => resolve(errorResponse(frame)));
    }),
  });
  const first = await ready(h);
  const second = binding({
    routeId: "route-two",
    routeFence: "fence-two",
    connectionId: "connection-two",
    authContext: { jti: "jti-two" },
  });
  await ready(h, second);
  const firstQuery = fixture("command-query");
  firstQuery.requestId = "query-first-route";
  firstQuery.expectedHostEpoch = HOST_EPOCH;
  const secondQuery = structuredClone(firstQuery);
  secondQuery.requestId = "query-second-route";
  send(h.runtime, first, firstQuery);
  send(h.runtime, second, secondQuery);
  await settle(2);
  pending.get(secondQuery.requestId)();
  pending.get(firstQuery.requestId)();
  await settle(6);

  const firstDelivery = h.state.sent.find(({ frame }) => frame.requestId === firstQuery.requestId);
  const secondDelivery = h.state.sent.find(({ frame }) => frame.requestId === secondQuery.requestId);
  assert.deepEqual(firstDelivery.binding, first);
  assert.deepEqual(secondDelivery.binding, second);
  assert.equal(firstDelivery.frame.requestId, firstQuery.requestId);
  assert.equal(secondDelivery.frame.requestId, secondQuery.requestId);
});

test("unknown types, opposite-direction frames, and closed-schema extensions fail closed", async (t) => {
  const cases = [
    {
      name: "unknown type",
      bytes: Buffer.from(JSON.stringify({
        protocolVersion: 2,
        kind: "request",
        type: "host.future.mutation",
        requestId: "future-request",
        payload: {},
      })),
    },
    {
      name: "opposite direction host response",
      bytes: codec.encodeRelayV2WebSocketFrame("public", fixture("host-welcome-snapshot-required")),
    },
    {
      name: "unknown closed-schema field",
      bytes: Buffer.from(JSON.stringify({
        ...fixture("command-query"),
        unknownExtension: true,
      })),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const h = createHarness();
      const routeBinding = await ready(h);
      const callsBefore = Object.values(h.state.calls).reduce((sum, entries) => sum + entries.length, 0);
      h.runtime.onClientFrame(routeBinding, scenario.bytes);
      await settle();
      const callsAfter = Object.values(h.state.calls).reduce((sum, entries) => sum + entries.length, 0);
      assert.equal(callsAfter, callsBefore + 2, "only route unsubscribe and terminal unbind may run");
      assert.equal(h.state.closes.at(-1).reason, "protocol_error");
      assert.equal(h.state.calls.commandExecute.length, 0);
      assert.equal(h.state.calls.commandQuery.length, 0);
      assert.equal(h.state.calls.terminal.length, 0);
    });
  }
});
