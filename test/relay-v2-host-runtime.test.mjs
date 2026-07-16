import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const broker = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const hostState = await import("../dist/relay/v2/hostState.js");
const resourceState = await import("../dist/relay/v2/resourceState.js");
const snapshotSpool = await import("../dist/relay/v2/stateSnapshotSpool.js");
const terminalManager = await import("../dist/relay/v2/terminalManager.js");
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

function hostWelcome(input) {
  const welcome = fixture("host-welcome-snapshot-required");
  welcome.requestId = input.hello.requestId;
  welcome.hostId = HOST_ID;
  welcome.hostEpoch = input.cut.hostEpoch;
  welcome.hostInstanceId = input.cut.hostInstanceId;
  welcome.payload.eventSeq = input.cut.eventSeq;
  welcome.payload.capabilities = [...input.capabilities];
  welcome.payload.commandDedupeWindow = structuredClone(input.commandDedupeWindow);
  return welcome;
}

function createHarness(options = {}) {
  const state = {
    identity: {
      hostEpoch: HOST_EPOCH,
      hostInstanceId: HOST_INSTANCE_ID,
    },
    capabilities: capabilityIntersection(options.capabilityOverrides),
    readinessGeneration: "readiness-1",
    readinessSink: null,
    order: [],
    calls: {
      commandExecute: [],
      commandQuery: [],
      commandWindow: [],
      hello: [],
      welcomeSinkReceipts: [],
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
    async issueDedupeWindow() {
      state.calls.commandWindow.push(true);
      state.order.push("h1-window");
      if (options.issueDedupeWindow) return options.issueDedupeWindow();
      return {
        windowId: "dedupe-window-runtime",
        windowSeq: "42",
        acceptUntilMs: 1_783_786_400_000,
        queryUntilMs: 1_784_391_200_000,
      };
    },
  };
  const resources = {
    async linearizeWelcome(subscriberId, sink, buildWelcome) {
      state.calls.hello.push(subscriberId);
      state.order.push("h2-welcome");
      const cut = {
        hostEpoch: state.identity.hostEpoch,
        hostInstanceId: state.identity.hostInstanceId,
        eventSeq: "91",
        requiresSnapshot: true,
      };
      if (options.hello) return options.hello({ subscriberId, cut, buildWelcome }, sink);
      const welcome = buildWelcome(cut);
      const accepted = sink.enqueue(welcome);
      state.calls.welcomeSinkReceipts.push(accepted);
      if (!accepted) throw new resourceState.RelayV2MaterializedStateError(
        "BUSY",
        "fake H2 observed a bounded subscriber rejection",
      );
      return welcome;
    },
    async scopesSnapshot(requestId, expectedHostEpoch) {
      const request = { requestId, expectedHostEpoch, hostId: HOST_ID };
      state.calls.scopes.push(structuredClone(request));
      return options.scopesSnapshot?.(request) ?? errorResponse(request);
    },
    async sessionsSnapshot(requestId, expectedHostEpoch, scopeIds) {
      const request = { requestId, expectedHostEpoch, scopeIds, hostId: HOST_ID };
      state.calls.sessions.push(structuredClone(request));
      return options.sessionsSnapshot?.(request) ?? errorResponse(request);
    },
    unsubscribe(subscriberId) {
      state.calls.unsubscribe.push(subscriberId);
    },
  };
  const snapshots = {
    async get(request) {
      state.calls.snapshotGet.push(structuredClone(request));
      if (options.stateSnapshotGet) return options.stateSnapshotGet(request);
      const frame = fixture("state-snapshot-chunk");
      return { hostEpoch: frame.hostEpoch, ...structuredClone(frame.payload) };
    },
    async release(request) {
      state.calls.snapshotRelease.push(structuredClone(request));
      if (options.stateSnapshotRelease) return options.stateSnapshotRelease(request);
      const frame = fixture("state-snapshot-released");
      return { hostEpoch: frame.hostEpoch, ...structuredClone(frame.payload) };
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
    trySend(routeBinding, bytes, receipt) {
      const frame = codec.decodeRelayV2WebSocketFrame("public", bytes).frame;
      state.sent.push({ binding: routeBinding, frame });
      if (options.trySend) return options.trySend(routeBinding, bytes, frame, receipt);
      receipt.settle(true);
      return true;
    },
    close(routeBinding, close) {
      state.closes.push({ binding: routeBinding, ...close });
    },
  };
  const readiness = {
    subscribe(sink) {
      assert.equal(state.readinessSink, null);
      state.readinessSink = sink;
      assert.equal(sink.apply({
        generation: state.readinessGeneration,
        capabilities: structuredClone(state.capabilities),
      }), true);
      return {
        unsubscribe() {
          if (state.readinessSink === sink) state.readinessSink = null;
        },
      };
    },
    publish(capabilities = state.capabilities) {
      state.readinessGeneration = `readiness-${Number(state.readinessGeneration.split("-")[1]) + 1}`;
      return state.readinessSink.apply({
        generation: state.readinessGeneration,
        capabilities: structuredClone(capabilities),
      });
    },
    withdraw() {
      state.readinessSink.close();
    },
  };
  const runtime = new runtimeModule.RelayV2HostRuntime({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    identity: {
      current: options.currentIdentity ?? (async () => structuredClone(state.identity)),
    },
    capabilityIntersection: readiness,
    commands,
    resources,
    snapshots,
    terminals,
    welcome: { build: options.buildWelcome ?? hostWelcome },
    outbound,
    testLimits: options.testLimits,
  });
  return { runtime, state, readiness, commands, resources, snapshots, terminals, outbound };
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
  assert.deepEqual(h.state.order.slice(0, 2), ["h1-window", "h2-welcome"]);
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
    expectedHostEpoch: HOST_EPOCH,
    principalId: "principal-one",
    clientInstanceId: "android-one",
    snapshotRequestId: frames[4].payload.snapshotRequestId,
    snapshotId: null,
    cursor: null,
    nextChunkIndex: 0,
  });
  assert.deepEqual(
    h.state.sent.map(({ frame }) => frame.type),
    [
      "host.welcome",
      "error",
      "error",
      "error",
      "error",
      "state.snapshot.chunk",
      "state.snapshot.released",
    ],
  );
  assert.deepEqual(h.state.closes, []);
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
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.state.closes.at(-1).code, 4406);
  assert.equal(h.state.closes.at(-1).reason, "capability_withdrawn");
  assert.equal(h.state.calls.commandExecute.length, 0);
  assert.equal(h.state.calls.terminal.length, 0);

  h.state.capabilities["terminal.stream.resume.v1"] = true;
  assert.equal(h.readiness.publish(), true);
  assert.deepEqual(
    h.runtime.advertisedCapabilities(),
    [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  );
});

test("bounded readiness withdrawal synchronously fences every established route", async () => {
  for (const capability of broker.RELAY_V2_REQUIRED_CAPABILITIES) {
    const h = createHarness();
    const routeBinding = await ready(h);
    const sentBefore = h.state.sent.length;
    h.state.capabilities[capability] = false;

    assert.equal(h.readiness.publish(), true);
    assert.deepEqual(h.runtime.advertisedCapabilities(), []);
    assert.equal(h.state.closes.at(-1).code, 4406);
    assert.equal(h.state.closes.at(-1).reason, "capability_withdrawn");
    assert.equal(h.state.calls.unsubscribe.includes("host-route-1"), true);
    assert.equal(h.state.calls.unbind.length, 1);
    assert.equal(h.state.sent.length, sentBefore);

    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle();
    assert.equal(h.state.calls.commandExecute.length, 0);
  }
});

test("readiness withdrawal during hello leaves no welcome or subscriber gap", async () => {
  let releaseWindow;
  const window = new Promise((resolve) => { releaseWindow = resolve; });
  const h = createHarness({ issueDedupeWindow: () => window });
  const routeBinding = binding();
  h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle(2);
  assert.deepEqual(h.state.order, ["h1-window"]);

  h.state.capabilities["snapshot.revision.v1"] = false;
  assert.equal(h.readiness.publish(), true);
  releaseWindow({
    windowId: "withdrawn-window",
    windowSeq: "43",
    acceptUntilMs: 1_783_786_400_000,
    queryUntilMs: 1_784_391_200_000,
  });
  await settle(6);

  assert.equal(h.state.calls.hello.length, 0);
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.state.calls.unsubscribe.includes("host-route-1"), true);
  assert.equal(h.state.calls.unbind.length, 1);
  assert.equal(h.state.closes.at(-1).code, 4406);
});

test("welcome builder TOCTOU withdrawal rejects the synchronous H2 sink without a gap", async () => {
  let h;
  h = createHarness({
    buildWelcome(input) {
      h.state.capabilities["event.sequence.v1"] = false;
      assert.equal(h.readiness.publish(), true);
      return hostWelcome(input);
    },
  });
  const routeBinding = binding();
  h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle(8);

  assert.equal(h.state.sent.length, 0);
  assert.deepEqual(h.state.calls.welcomeSinkReceipts, [false]);
  assert.equal(h.state.calls.unsubscribe.includes("host-route-1"), true);
  assert.equal(h.state.calls.unbind.length, 1);
  assert.equal(h.state.closes.at(-1).code, 4406);
  assert.equal(h.state.closes.at(-1).reason, "capability_withdrawn");
});

test("every awaited authority and transport receipt revalidates binding and H0 lineage", async (t) => {
  await t.test("the H1 dedupe window cannot enter H2 after a lineage change", async () => {
    let finishWindow;
    const deferred = new Promise((resolve) => { finishWindow = resolve; });
    const h = createHarness({ issueDedupeWindow: () => deferred });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await settle(2);
    h.state.identity.hostEpoch = "replacement-host-epoch";
    finishWindow({
      windowId: "stale-window",
      windowSeq: "44",
      acceptUntilMs: 1_783_786_400_000,
      queryUntilMs: 1_784_391_200_000,
    });
    await settle(6);
    assert.deepEqual(h.state.order, ["h1-window"]);
    assert.equal(h.state.calls.hello.length, 0);
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.state.closes.at(-1).code, 4400);
  });

  await t.test("a completed H1 call cannot emit after the host epoch changes", async () => {
    let finish;
    const deferred = new Promise((resolve) => { finish = resolve; });
    const h = createHarness({ execute: async () => deferred });
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle(2);
    assert.equal(h.state.calls.commandExecute.length, 1);
    const sentBefore = h.state.sent.length;
    h.state.identity.hostEpoch = "replacement-host-epoch";
    finish(errorResponse(command));
    await settle(6);

    assert.equal(h.state.sent.length, sentBefore);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    assert.equal(h.state.closes.at(-1).code, 4400);
  });

  await t.test("a completed H2 call cannot emit after the host instance changes", async () => {
    let finish;
    const deferred = new Promise((resolve) => { finish = resolve; });
    const h = createHarness({ scopesSnapshot: async () => deferred });
    const routeBinding = await ready(h);
    const request = fixture("scopes-snapshot-get");
    request.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, request);
    await settle(2);
    assert.equal(h.state.calls.scopes.length, 1);
    const sentBefore = h.state.sent.length;
    h.state.identity.hostInstanceId = "replacement-host-instance";
    finish(errorResponse({ ...request, hostId: HOST_ID }));
    await settle(6);

    assert.equal(h.state.sent.length, sentBefore);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === request.requestId), false);
    assert.equal(h.state.closes.at(-1).code, 4400);
  });

  await t.test("H3 callback and awaited completion cannot cross a lineage change", async () => {
    let authorityRoute;
    let finishOpen;
    const open = new Promise((resolve) => { finishOpen = resolve; });
    const h = createHarness({
      terminal: async (method, request) => {
        if (method === "open") {
          authorityRoute = request.route;
          return open;
        }
      },
    });
    const routeBinding = await ready(h);
    const request = fixture("terminal-open-new");
    request.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, request);
    await settle(2);
    h.state.identity.hostEpoch = "replacement-host-epoch";
    const opened = fixture("terminal-opened");
    opened.requestId = request.requestId;
    opened.hostId = HOST_ID;
    opened.hostEpoch = HOST_EPOCH;
    await assert.rejects(
      h.runtime.sendTerminalFrame(authorityRoute, opened),
      /lost its route fence/,
    );
    const sentBefore = h.state.sent.length;
    finishOpen();
    await settle(6);
    assert.equal(h.state.sent.length, sentBefore);
    assert.equal(h.state.closes.at(-1).code, 4400);
  });

  await t.test("a transport receipt fences queued frames before the next delivery", async () => {
    let firstReceipt;
    const h = createHarness({
      trySend: (_binding, _bytes, frame, receipt) => {
        if (frame.type === "host.welcome") {
          receipt.settle(true);
        } else if (firstReceipt === undefined) {
          firstReceipt = receipt;
        } else {
          receipt.settle(true);
        }
        return true;
      },
    });
    const routeBinding = await ready(h);
    const first = fixture("command-query");
    first.requestId = "receipt-query-one";
    first.expectedHostEpoch = HOST_EPOCH;
    const second = structuredClone(first);
    second.requestId = "receipt-query-two";
    send(h.runtime, routeBinding, first);
    send(h.runtime, routeBinding, second);
    await settle(4);
    assert.equal(typeof firstReceipt?.settle, "function");
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === second.requestId), false);
    h.state.identity.hostEpoch = "replacement-host-epoch";
    firstReceipt.settle(true);
    await settle(6);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === second.requestId), false);
    assert.equal(h.state.closes.at(-1).code, 4400);
  });
});

test("request ownership and response metadata fence cross-owner or retargeted frames", async (t) => {
  await t.test("H3 cannot borrow a pending command requestId", async () => {
    let finishCommand;
    let authorityRoute;
    const commandResult = new Promise((resolve) => { finishCommand = resolve; });
    const h = createHarness({
      execute: async () => commandResult,
      terminal: async (_method, request) => { authorityRoute = request.route; },
    });
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    const ack = fixture("terminal-output-ack");
    send(h.runtime, routeBinding, ack);
    await settle(3);

    await assert.rejects(
      h.runtime.sendTerminalFrame(authorityRoute, errorResponse(command)),
      /not owned by a terminal request/,
    );
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    finishCommand(errorResponse(command));
    await settle(5);
  });

  await t.test("H1 response type is constrained by its exact request owner", async () => {
    const h = createHarness({
      execute: async (_auth, request) => {
        const response = fixture("command-statuses-all-states");
        response.requestId = request.requestId;
        response.hostId = HOST_ID;
        response.hostEpoch = HOST_EPOCH;
        return response;
      },
    });
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle(6);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    assert.equal(h.state.closes.at(-1).reason, "authority_failure");
  });

  for (const field of ["hostId", "hostEpoch", "commandId", "scopeId"]) {
    await t.test(`H1 response ${field} must match its request metadata`, async () => {
      const h = createHarness({
        execute: async (_auth, request) => ({
          ...errorResponse(request),
          [field]: `retargeted-${field}`,
        }),
      });
      const routeBinding = await ready(h);
      const command = fixture("command-execute-send-agent-message");
      command.expectedHostEpoch = HOST_EPOCH;
      send(h.runtime, routeBinding, command);
      await settle(6);
      assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
      assert.equal(h.state.closes.at(-1).code, 1013);
    });
  }
});

test("owner failures are redacted and EVENT_CURSOR_AHEAD retains exact protocol semantics", async (t) => {
  await t.test("an arbitrary H1 throw emits no invented command disposition or secret", async () => {
    const secret = "token-super-secret";
    const h = createHarness({ execute: async () => { throw new Error(`${secret}\nstack-material`); } });
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle(6);

    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    assert.equal(JSON.stringify(h.state.sent).includes(secret), false);
    assert.equal(h.state.closes.at(-1).code, 1013);
    assert.equal(h.state.closes.at(-1).reason, "authority_failure");
  });

  await t.test("EVENT_CURSOR_AHEAD is correlated with exact details and closes 4400", async () => {
    const h = createHarness({
      buildWelcome: () => {
        throw new runtimeModule.RelayV2HostRuntimeAuthorityError("EVENT_CURSOR_AHEAD", {
          clientLastEventSeq: "92",
          hostEventSeq: "91",
        });
      },
    });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await settle(8);

    const response = h.state.sent[0].frame;
    assert.equal(response.requestId, hello.requestId);
    assert.equal(response.error.code, "EVENT_CURSOR_AHEAD");
    assert.equal(response.error.message, "Client event cursor is ahead of the current host event sequence");
    assert.deepEqual({ ...response.error.details }, {
      clientLastEventSeq: "92",
      hostEventSeq: "91",
    });
    assert.equal(h.state.closes.at(-1).code, 4400);
    assert.equal(h.state.closes.at(-1).reason, "event_cursor_ahead");
  });
});

test("raw frame and transport-owned outbound capacity are hard bounded", async (t) => {
  await t.test("raw bytes are rejected before codec or authority work", async () => {
    for (const { maxFrameBytes, rawBytes } of [
      { maxFrameBytes: 256, rawBytes: 257 },
      { maxFrameBytes: 2_097_152, rawBytes: 1_048_577 },
    ]) {
      const h = createHarness();
      const routeBinding = binding({ maxFrameBytes });
      h.runtime.onRouteBound(routeBinding);
      h.runtime.onClientFrame(routeBinding, Buffer.alloc(rawBytes, 0x20));
      assert.equal(h.state.calls.hello.length, 0);
      assert.equal(h.state.closes.at(-1).code, 4400);
    }
  });

  await t.test("transport ownership remains charged until its receipt", async () => {
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      trySend: () => true,
      hello: async ({ cut, buildWelcome }, sink) => {
        assert.equal(sink.enqueue(buildWelcome(cut)), true);
        const event = fixture("sessions-changed-upsert");
        event.hostId = HOST_ID;
        event.hostEpoch = HOST_EPOCH;
        assert.equal(sink.enqueue(event), false);
      },
    });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await settle(6);
    assert.equal(h.state.closes.at(-1).code, 1013);
    assert.equal(h.state.closes.at(-1).reason, "slow_consumer");
  });

  await t.test("missing transport receipt times out and advances close", async () => {
    const h = createHarness({
      testLimits: { outboundReceiptTimeoutMs: 10 },
      trySend: () => true,
    });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await settle(2);
    assert.equal(h.state.closes.at(-1).code, 1013);
    assert.equal(h.state.closes.at(-1).reason, "slow_consumer");
  });
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
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      trySend: () => true,
      hello: async ({ cut, buildWelcome }, sink) => {
        assert.equal(sink.enqueue(buildWelcome(cut)), true);
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

test("the actual H0/H1/H2/spool/H3 adapter wires authorities without becoming one", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-relay-v2-host-runtime-actual-"));
  let spool;
  let h3;
  try {
    const store = await hostState.RelayV2HostStateStore.open({ home });
    const now = 1_783_700_000_000;
    const h1 = await commandPlane.RelayV2HostCommandPlane.open({
      store,
      hostId: HOST_ID,
      recover: false,
      now: () => now,
      executor: {
        async resolve() { throw new Error("actual adapter test never executes a command"); },
        async executeTwRpc() { throw new Error("actual adapter test never executes tw rpc"); },
        async executeTerminalControl() {
          throw new Error("actual adapter test never executes terminal control");
        },
      },
    });
    const h2 = new resourceState.RelayV2MaterializedStateFoundation({
      hostId: HOST_ID,
      store,
      discovery: {
        async scan() { return { coverage: "complete", scopes: [] }; },
      },
      readinessSink: { apply: () => true },
    });
    const reconciled = await h2.reconcile();
    spool = await snapshotSpool.RelayV2StateSnapshotSpool.open({
      hostId: HOST_ID,
      cutSource: h2.snapshotCutSource,
      root: join(home, "snapshot-spool"),
      ownerInstanceId: reconciled.snapshot.hostInstanceId,
    });
    h3 = new terminalManager.RelayV2TerminalManager({
      hostId: HOST_ID,
      hostEpoch: reconciled.snapshot.hostEpoch,
      hostInstanceId: reconciled.snapshot.hostInstanceId,
      resolver: {},
      lineage: {},
      backend: {},
      terminalControl: {},
      send: async () => {},
    });
    const ports = runtimeModule.createRelayV2HostRuntimeAuthorityPorts({
      h0: store,
      h1,
      h2,
      snapshotSpool: spool,
      h3,
      nextDedupeWindowBounds: () => ({
        acceptUntilMs: now + 60_000,
        queryUntilMs: now + 60_000 + commandPlane.RELAY_V2_COMMAND_DEDUPE_RETENTION_MS,
      }),
    });
    const sent = [];
    const closes = [];
    const runtime = new runtimeModule.RelayV2HostRuntime({
      hostId: HOST_ID,
      hostEpoch: reconciled.snapshot.hostEpoch,
      hostInstanceId: reconciled.snapshot.hostInstanceId,
      ...ports,
      capabilityIntersection: {
        subscribe(sink) {
          assert.equal(sink.apply({
            generation: "actual-authorities-ready",
            capabilities: capabilityIntersection(),
          }), true);
          return { unsubscribe() {} };
        },
      },
      welcome: { build: hostWelcome },
      outbound: {
        trySend(routeBinding, bytes, receipt) {
          sent.push({
            binding: routeBinding,
            frame: codec.decodeRelayV2WebSocketFrame("public", bytes).frame,
          });
          receipt.settle(true);
          return true;
        },
        close(routeBinding, close) { closes.push({ binding: routeBinding, ...close }); },
      },
    });
    const routeBinding = binding();
    runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.hostId = HOST_ID;
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(runtime, routeBinding, hello);
    await settle(10);

    const welcome = sent.find(({ frame }) => frame.type === "host.welcome")?.frame;
    assert.equal(welcome.hostEpoch, reconciled.snapshot.hostEpoch);
    assert.equal(welcome.hostInstanceId, reconciled.snapshot.hostInstanceId);
    assert.equal(typeof welcome.payload.commandDedupeWindow.windowId, "string");
    const scopes = fixture("scopes-snapshot-get");
    scopes.hostId = HOST_ID;
    scopes.expectedHostEpoch = reconciled.snapshot.hostEpoch;
    send(runtime, routeBinding, scopes);
    await settle(8);
    assert.equal(sent.at(-1).frame.type, "scopes.snapshot");
    assert.equal(sent.at(-1).frame.hostEpoch, reconciled.snapshot.hostEpoch);
    assert.deepEqual(sent.at(-1).frame.payload.items, []);
    const snapshot = fixture("state-snapshot-get-first");
    snapshot.hostId = HOST_ID;
    snapshot.expectedHostEpoch = reconciled.snapshot.hostEpoch;
    send(runtime, routeBinding, snapshot);
    await settle(10);
    assert.equal(sent.at(-1).frame.type, "state.snapshot.chunk");
    assert.equal(sent.at(-1).frame.hostEpoch, reconciled.snapshot.hostEpoch);
    assert.deepEqual(sent.at(-1).frame.payload.records, []);
    assert.deepEqual(closes, []);
    runtime.onRouteUnbound(routeBinding, "client_closed");
    runtime.dispose();
  } finally {
    await h3?.shutdown();
    await spool?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a misrouted v1 dialect is rejected as 4406 without entering the v2 runtime", () => {
  const h = createHarness();
  const legacyBinding = {
    ...binding(),
    clientDialect: "tw-relay.v1",
    authContext: {
      scheme: "legacy_shared_secret",
      role: "client",
      hostId: HOST_ID,
      principalId: null,
      grantId: null,
      clientInstanceId: null,
    },
  };
  h.runtime.onRouteBound(legacyBinding);
  assert.equal(h.state.closes.at(-1).code, 4406);
  assert.equal(h.state.closes.at(-1).reason, "route_unavailable");
  assert.equal(h.state.calls.hello.length, 0);
  assert.equal(h.state.calls.commandExecute.length, 0);
  assert.equal(h.state.calls.terminal.length, 0);
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
      assert.equal(h.state.closes.at(-1).code, 4400);
      assert.equal(h.state.closes.at(-1).reason, "protocol_error");
      assert.equal(h.state.calls.commandExecute.length, 0);
      assert.equal(h.state.calls.commandQuery.length, 0);
      assert.equal(h.state.calls.terminal.length, 0);
    });
  }
});
