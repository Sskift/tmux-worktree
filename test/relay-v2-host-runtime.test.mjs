import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRelayV2FixtureCorpus } from "./support/relayV2Fixtures.mjs";

const broker = await import("../dist/relay/v2/brokerCore.js");
const codec = await import("../dist/relay/v2/codec.js");
const commandPlane = await import("../dist/relay/v2/hostCommandPlane.js");
const hostCarrier = await import("../dist/relay/v2/hostCarrier.js");
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

function correlatedTerminalFixture(name, request) {
  const frame = fixture(name);
  frame.requestId = request.requestId;
  frame.hostId = request.hostId;
  frame.hostEpoch = HOST_EPOCH;
  frame.scopeId = request.scopeId;
  frame.sessionId = request.sessionId;
  frame.streamId = request.streamId;
  if (name === "terminal-opened") {
    frame.payload.openId = request.payload.openId;
    frame.payload.disposition = request.payload.mode === "resume"
      ? "resumed"
      : request.payload.mode;
    frame.payload.replayFromOffset = request.payload.mode === "resume"
      ? request.payload.resume.nextOffset
      : "0";
    if (request.payload.mode === "resume") {
      frame.payload.generation = request.payload.resume.generation;
    } else if (request.payload.mode === "reset"
      && frame.payload.generation === request.payload.resume?.generation) {
      frame.payload.generation = "reset-generation-uuid";
    }
  }
  if (name === "terminal-replay-started") {
    frame.payload.generation = request.payload.generation;
    frame.payload.fromOffset = request.payload.fromOffset;
  }
  if (name === "terminal-reset-required-response") {
    frame.payload.origin = request.type === "terminal.open" ? "open" : "replay";
    frame.payload.generation = request.payload.generation ?? request.payload.resume?.generation ?? null;
    frame.payload.requestedOffset = request.payload.fromOffset ?? request.payload.resume?.nextOffset ?? null;
  }
  if (name === "terminal-closed-response") {
    frame.payload.closeId = request.payload.closeId;
    frame.payload.generation = request.payload.generation;
  }
  return frame;
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
    return options.unbind?.(auth, route);
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

function actualTerminalRuntimeHarness(options = {}) {
  let manager;
  let nextGeneration = 0;
  let nextCloseOwnerFence = 0;
  let nextToken = 0;
  let now = 1_000_000;
  const closeRecords = new Map();
  const openRecords = new Map();
  const streamAuthorities = new Map();
  const backend = {
    opens: [],
    async open(_target, _openOptions, observer) {
      const handle = {
        closeCalls: 0,
        async pause() {},
        async resume() {},
        async setDisplaySizeHint() {},
        async close() { this.closeCalls += 1; },
      };
      backend.opens.push({ observer, handle });
      return handle;
    },
  };
  const lineage = {
    claimCloseCalls: [],
    async claimOpen(claim) {
      const openRecord = openRecords.get(claim.key);
      if (openRecord) {
        if (openRecord.fingerprint !== claim.fingerprint) {
          return { status: "conflict", reason: "open_conflict" };
        }
        return { status: "replay", outcome: structuredClone(openRecord.outcome) };
      }
      const retained = streamAuthorities.get(claim.streamKey);
      const streamAuthority = retained
        ? {
            status: retained.status,
            generation: retained.generation,
            target: structuredClone(retained.target),
            pane: retained.pane,
            resumeTokenHash: retained.resumeTokenHash,
          }
        : { status: "absent" };
      const issuedGeneration = claim.mode === "resume"
        ? null
        : `actual-authority-generation-${++nextGeneration}`;
      openRecords.set(claim.key, {
        fingerprint: claim.fingerprint,
        streamKey: claim.streamKey,
        target: structuredClone(claim.target),
        pane: claim.pane,
        issuedGeneration,
        streamAuthority: structuredClone(streamAuthority),
        outcome: null,
      });
      return {
        status: "claimed",
        claimToken: `actual-claim-${claim.key}`,
        fence: `actual-fence-${claim.key}`,
        issuedGeneration,
        streamAuthority,
      };
    },
    async completeOpen(input) {
      const openRecord = openRecords.get(input.key);
      assert.ok(openRecord);
      openRecord.outcome = structuredClone(input.outcome);
      if (input.outcome.kind === "opened" && input.outcome.disposition !== "resumed") {
        assert.equal(input.outcome.generation, openRecord.issuedGeneration);
        streamAuthorities.set(openRecord.streamKey, {
          status: "live",
          generation: input.outcome.generation,
          target: structuredClone(openRecord.target),
          pane: openRecord.pane,
          resumeTokenHash: input.outcome.resumeTokenHash,
        });
      }
      return { status: "committed", outcome: structuredClone(input.outcome) };
    },
    async failOpen(input) {
      const openRecord = openRecords.get(input.key);
      assert.ok(openRecord);
      openRecord.outcome = structuredClone(input.outcome);
      if (input.streamEffect.kind === "retire_previous") {
        const retained = streamAuthorities.get(openRecord.streamKey);
        if (retained?.generation === input.streamEffect.generation) {
          streamAuthorities.delete(openRecord.streamKey);
        }
      }
      return { status: "committed", outcome: structuredClone(input.outcome) };
    },
    async claimClose(input) {
      lineage.claimCloseCalls.push(structuredClone(input));
      const retained = closeRecords.get(input.key);
      if (retained) {
        if (retained.state === "final") {
          return { status: "final", tombstone: structuredClone(retained.value) };
        }
        retained.ownerFence = `${++nextCloseOwnerFence}`;
        return {
          status: "existing_intent",
          intent: structuredClone(retained.value),
          ownerFence: retained.ownerFence,
        };
      }
      if (!input.intent) return { status: "not_found" };
      const ownerFence = `${++nextCloseOwnerFence}`;
      closeRecords.set(input.key, {
        state: "intent",
        ownerFence,
        value: structuredClone(input.intent),
      });
      return { status: "claimed", intent: structuredClone(input.intent), ownerFence };
    },
    async finalizeClose(input) {
      const retained = closeRecords.get(input.key);
      assert.ok(retained);
      assert.equal(input.fingerprint, retained.value.fingerprint);
      assert.equal(input.ownerFence, retained.ownerFence);
      retained.state = "final";
      const authority = streamAuthorities.get(retained.value.streamKey);
      if (authority?.generation === retained.value.generation) authority.status = "closed";
      return structuredClone(retained.value);
    },
    async markStreamClosed(input) {
      const retained = streamAuthorities.get(input.streamKey);
      if (!retained || retained.generation !== input.generation) {
        return { status: "conflict", reason: "stream_identity_mismatch" };
      }
      const alreadyClosed = retained.status === "closed";
      retained.status = "closed";
      return { status: alreadyClosed ? "already_closed" : "closed" };
    },
    async releaseStreamReservation(input) {
      const retained = streamAuthorities.get(input.streamKey);
      if (!retained) return { status: "already_released" };
      if (retained.generation !== input.generation) {
        return { status: "conflict", reason: "generation_mismatch" };
      }
      streamAuthorities.delete(input.streamKey);
      return { status: "released" };
    },
  };
  const h = createHarness({
    testLimits: options.runtimeLimits,
    terminal: (method, request) => manager[method](request),
    unbind: (auth, route) => manager.unbind(auth, route),
  });
  manager = new terminalManager.RelayV2TerminalManager({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    resolver: {
      async resolve(input) {
        return {
          ...structuredClone(input.target),
          pane: input.pane,
          canonicalTargetId: "actual-runtime-canonical-target",
          controlTargetId: "actual-runtime-control-target",
        };
      },
    },
    lineage,
    backend,
    terminalControl: {},
    send: async (route, frame, responseLineage) => {
      const deliver = () => h.runtime.sendTerminalFrame(
        { ...route },
        frame,
        responseLineage === undefined ? undefined : { ...responseLineage },
      );
      if (options.terminalSend) {
        return options.terminalSend(route, frame, responseLineage, deliver);
      }
      return deliver();
    },
    now: () => now,
    issueToken: () => `actual-runtime-token-${++nextToken}`,
    limits: options.terminalLimits,
  });
  return {
    h,
    manager,
    backend,
    lineage,
    advance(milliseconds) { now += milliseconds; },
  };
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
  const rejection = h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle();

  assert.equal(h.state.calls.hello.length, 0);
  assert.equal(h.state.sent.length, 0);
  assert.deepEqual(rejection, {
    accepted: false,
    code: "CAPABILITY_UNAVAILABLE",
    message: "Relay v2 host capability intersection is unavailable",
    retryable: false,
  });
  assert.equal(h.state.closes.length, 0);
  assert.equal(h.state.calls.commandExecute.length, 0);
  assert.equal(h.state.calls.terminal.length, 0);

  h.state.capabilities["terminal.stream.resume.v1"] = true;
  assert.equal(h.readiness.publish(), true);
  assert.deepEqual(
    h.runtime.advertisedCapabilities(),
    [...broker.RELAY_V2_REQUIRED_CAPABILITIES],
  );
});

test("HostCarrier turns a runtime readiness rejection into route.rejected", () => {
  const h = createHarness({
    capabilityOverrides: { "terminal.stream.resume.v1": false },
  });
  const sent = [];
  const deliveries = [];
  const transport = {
    trySend(bytes, deliveryToken) {
      sent.push(Uint8Array.from(bytes));
      deliveries.push(deliveryToken);
      return true;
    },
    bufferedAmount() { return 0; },
    close() {},
  };
  const actor = new hostCarrier.RelayV2HostCarrierActor({
    hostId: HOST_ID,
    hostEpoch: HOST_EPOCH,
    hostInstanceId: HOST_INSTANCE_ID,
    credentialReferences: {
      read(reference) {
        return {
          reference,
          version: "1",
          grantId: "test-host-grant",
          accessJti: "test-host-access-jti",
          accessToken: "twcap2.test.payload.mac",
        };
      },
      acknowledgeReauthentication() { return true; },
    },
    advertisedCapabilities: [],
    clientDialects: ["tw-relay.v2"],
    idFactory: () => "host-hello-runtime-rejection",
    clock: () => 1_783_700_100_000,
    routeSink: h.runtime,
  });
  const connection = actor.connect(transport, "test-host-credential");
  const hello = codec.decodeRelayV2WebSocketFrame("carrier", sent.at(-1)).frame;
  connection.acknowledge(deliveries.shift());
  const registered = fixture("host-registered");
  registered.requestId = hello.requestId;
  registered.connectorId = "runtime-rejection-connector";
  connection.receive(codec.encodeRelayV2WebSocketFrame("carrier", registered));
  while (deliveries.length > 0) connection.acknowledge(deliveries.shift());

  const routeOpen = fixture("route-open");
  routeOpen.connectorId = registered.connectorId;
  routeOpen.payload.authContext.hostId = HOST_ID;
  connection.receive(codec.encodeRelayV2WebSocketFrame("carrier", routeOpen));
  const rejected = codec.decodeRelayV2WebSocketFrame("carrier", sent.at(-1)).frame;
  assert.equal(rejected.type, "route.rejected");
  assert.equal(rejected.requestId, routeOpen.requestId);
  assert.equal(rejected.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(rejected.error.commandDisposition, "not_applicable");
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

test("readiness withdrawal permanently fences the current connector generation", async () => {
  const h = createHarness();
  const first = await ready(h);
  h.state.capabilities["event.sequence.v1"] = false;
  assert.equal(h.readiness.publish(), true);
  assert.equal(h.state.closes.at(-1).code, 4406);

  h.state.capabilities["event.sequence.v1"] = true;
  assert.equal(h.readiness.publish(), true);
  assert.deepEqual(h.runtime.advertisedCapabilities(), [...broker.RELAY_V2_REQUIRED_CAPABILITIES]);

  const sameConnector = binding({
    routeId: "route-after-restore",
    routeFence: "fence-after-restore",
    connectionId: "connection-after-restore",
    authContext: { jti: "jti-after-restore" },
  });
  assert.deepEqual(h.runtime.onRouteBound(sameConnector), {
    accepted: false,
    code: "CAPABILITY_UNAVAILABLE",
    message: "Relay v2 capability was withdrawn for this connector generation",
    retryable: false,
  });

  const replacementConnector = binding({
    connectorGeneration: first.connectorGeneration + 1,
    connectorId: "connector-replacement",
    routeId: "route-replacement",
    routeFence: "fence-replacement",
    connectionId: "connection-replacement",
    authContext: { jti: "jti-replacement" },
  });
  assert.equal(h.runtime.onRouteBound(replacementConnector), undefined);
});

test("readiness withdrawal tombstones an observed generation after its routes unbind", async () => {
  const h = createHarness();
  const first = await ready(h);
  h.runtime.onRouteUnbound(first, "client_closed");
  await settle(5);

  h.state.capabilities["event.sequence.v1"] = false;
  assert.equal(h.readiness.publish(), true);
  h.state.capabilities["event.sequence.v1"] = true;
  assert.equal(h.readiness.publish(), true);

  const sameGeneration = binding({
    routeId: "route-observed-after-withdrawal",
    routeFence: "fence-observed-after-withdrawal",
    connectionId: "connection-observed-after-withdrawal",
    authContext: { jti: "jti-observed-after-withdrawal" },
  });
  assert.equal(h.runtime.onRouteBound(sameGeneration).code, "CAPABILITY_UNAVAILABLE");

  const nextGeneration = binding({
    connectorGeneration: first.connectorGeneration + 1,
    connectorId: first.connectorId,
    routeId: "route-next-generation",
    routeFence: "fence-next-generation",
    connectionId: "connection-next-generation",
    authContext: { jti: "jti-next-generation" },
  });
  assert.equal(h.runtime.onRouteBound(nextGeneration), undefined);
});

test("a capability-rejected connector generation is observed and tombstoned", () => {
  const missingCapability = "event.sequence.v1";
  const h = createHarness({ capabilityOverrides: { [missingCapability]: false } });
  const rejected = binding({
    connectorId: "rejected-generation-connector",
    routeId: "rejected-generation-route",
    routeFence: "rejected-generation-fence",
    connectionId: "rejected-generation-connection",
    authContext: { jti: "rejected-generation-jti" },
  });
  assert.equal(h.runtime.onRouteBound(rejected).code, "CAPABILITY_UNAVAILABLE");

  h.state.capabilities[missingCapability] = true;
  assert.equal(h.readiness.publish(), true);
  const sameGeneration = binding({
    connectorId: rejected.connectorId,
    routeId: "rejected-generation-restored-route",
    routeFence: "rejected-generation-restored-fence",
    connectionId: "rejected-generation-restored-connection",
    authContext: { jti: "rejected-generation-restored-jti" },
  });
  assert.equal(h.runtime.onRouteBound(sameGeneration).code, "CAPABILITY_UNAVAILABLE");

  const nextGeneration = binding({
    connectorGeneration: rejected.connectorGeneration + 1,
    connectorId: rejected.connectorId,
    routeId: "rejected-generation-next-route",
    routeFence: "rejected-generation-next-fence",
    connectionId: "rejected-generation-next-connection",
    authContext: { jti: "rejected-generation-next-jti" },
  });
  assert.equal(h.runtime.onRouteBound(nextGeneration), undefined);
});

test("readiness withdrawal publishes 4406 before a synchronous H3 unbind failure", async () => {
  const h = createHarness({ testLimits: { maxRoutes: 1 } });
  const routeBinding = await ready(h);
  h.terminals.unbind = (auth, route) => {
    h.state.calls.unbind.push({ auth: structuredClone(auth), route: structuredClone(route) });
    throw new Error("synchronous H3 unbind failure");
  };
  const closesBefore = h.state.closes.length;
  h.state.capabilities["event.sequence.v1"] = false;
  assert.equal(h.readiness.publish(), true);
  await settle(6);

  assert.deepEqual(h.state.closes.slice(closesBefore).map(({ code, reason }) => ({ code, reason })), [{
    code: 4406,
    reason: "capability_withdrawn",
  }]);
  assert.equal(h.state.calls.unbind.length, 1);
  h.state.capabilities["event.sequence.v1"] = true;
  assert.equal(h.readiness.publish(), true);
  const replacement = binding({
    connectorGeneration: routeBinding.connectorGeneration + 1,
    connectorId: "withdraw-unbind-next-connector",
    routeId: "withdraw-unbind-next-route",
    routeFence: "withdraw-unbind-next-fence",
    connectionId: "withdraw-unbind-next-connection",
    authContext: { jti: "withdraw-unbind-next-jti" },
  });
  assert.equal(h.runtime.onRouteBound(replacement).code, "BUSY");
  assert.equal(h.state.calls.unbind.length, 1, "failed unbind must remain draining without retry");
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

test("welcome cut hostInstance replacement fences 4409 without a false epoch mismatch", async () => {
  const h = createHarness({
    hello: async ({ cut, buildWelcome }) => buildWelcome({
      ...cut,
      hostInstanceId: "replacement-welcome-host-instance",
    }),
  });
  const routeBinding = binding();
  h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle(8);

  assert.equal(h.state.sent.length, 0);
  assert.equal(h.state.closes.at(-1).code, 4409);
  assert.equal(h.state.closes.at(-1).reason, "host_superseded");
  assert.equal(h.state.calls.unsubscribe.includes("host-route-1"), true);
  assert.equal(h.state.calls.unbind.length, 1);
});

test("pre-commit H2 welcome rejection returns correlated BUSY before fencing", async () => {
  const h = createHarness({
    testLimits: { maxPendingOperationsPerRoute: 1 },
    hello: async ({ cut, buildWelcome }, sink) => {
      const welcome = buildWelcome(cut);
      if (!sink.enqueue(welcome)) {
        const error = new resourceState.RelayV2MaterializedStateError(
          "BUSY",
          "actual H2 subscriber rejected host.welcome",
        );
        sink.close(error);
        throw error;
      }
      return welcome;
    },
  });
  const routeBinding = binding();
  h.runtime.onRouteBound(routeBinding);
  const hello = fixture("client-hello-fresh");
  hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
  send(h.runtime, routeBinding, hello);
  await settle(8);

  const response = h.state.sent.find(({ frame }) => frame.requestId === hello.requestId)?.frame;
  assert.equal(response.type, "error");
  assert.equal(response.error.code, "BUSY");
  assert.equal(response.error.commandDisposition, "not_applicable");
  assert.equal(h.state.closes.at(-1).code, 1013);
  assert.equal(h.state.calls.commandExecute.length, 0);
  assert.equal(h.state.calls.terminal.length, 0);
});

test("H2 welcome owns the real bounded outbound slot before its barrier commits", async (t) => {
  await t.test("byte capacity rejection leaves the barrier uncommitted and returns BUSY", async () => {
    let barrierCommits = 0;
    let sinkAccepted = null;
    const h = createHarness({
      testLimits: { maxOutboundBytesPerRoute: 1_000 },
      hello: async ({ cut, buildWelcome }, sink) => {
        const welcome = buildWelcome(cut);
        assert.ok(codec.encodeRelayV2WebSocketFrame("public", welcome).byteLength > 1_000);
        sinkAccepted = sink.enqueue(welcome);
        if (!sinkAccepted) {
          const error = new resourceState.RelayV2MaterializedStateError(
            "BUSY",
            "actual H2 welcome slot reservation was rejected",
          );
          sink.close(error);
          throw error;
        }
        barrierCommits += 1;
        return welcome;
      },
    });
    const routeBinding = binding();
    h.runtime.onRouteBound(routeBinding);
    const hello = fixture("client-hello-fresh");
    hello.payload.clientInstanceId = routeBinding.authContext.clientInstanceId;
    send(h.runtime, routeBinding, hello);
    await settle(8);

    assert.equal(sinkAccepted, false);
    assert.equal(barrierCommits, 0);
    assert.equal(h.state.sent.some(({ frame }) => frame.type === "host.welcome"), false);
    const response = h.state.sent.find(({ frame }) => frame.requestId === hello.requestId)?.frame;
    assert.equal(response.type, "error");
    assert.equal(response.error.code, "BUSY");
    assert.equal(response.error.commandDisposition, "not_applicable");
    assert.equal(h.state.closes.at(-1).code, 1013);
  });

  await t.test("a successful reservation is converted and released exactly once", async () => {
    let barrierCommits = 0;
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      hello: async ({ cut, buildWelcome }, sink) => {
        const welcome = buildWelcome(cut);
        assert.equal(sink.enqueue(welcome), true);
        barrierCommits += 1;
        return welcome;
      },
    });
    const routeBinding = await ready(h);
    const query = fixture("command-query");
    query.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, query);
    await settle(8);

    assert.equal(barrierCommits, 1);
    assert.equal(h.state.sent.filter(({ frame }) => frame.type === "host.welcome").length, 1);
    assert.equal(h.state.calls.commandQuery.length, 1);
    assert.equal(h.state.sent.filter(({ frame }) => frame.requestId === query.requestId).length, 1);
    assert.equal(h.state.closes.length, 0);
  });
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
    assert.equal(h.state.closes.at(-1).code, 4409);
    assert.equal(h.state.closes.at(-1).reason, "host_superseded");
  });

  await t.test("same-epoch host process replacement never fabricates an epoch mismatch", async () => {
    const h = createHarness();
    const routeBinding = await ready(h);
    h.state.identity.hostInstanceId = "replacement-host-instance";
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
    await settle(6);

    assert.equal(h.state.calls.commandExecute.length, 0);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    assert.equal(h.state.closes.at(-1).code, 4409);
    assert.equal(h.state.closes.at(-1).reason, "host_superseded");
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

test("H3 callbacks use copied exact tokens and each frozen terminal frame schema", async (t) => {
  async function openStream() {
    let authorityRoute;
    const h = createHarness({
      terminal: async (method, request) => {
        if (method === "open") authorityRoute = request.route;
      },
    });
    const routeBinding = await ready(h);
    const request = fixture("terminal-open-new");
    request.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, request);
    await settle(3);
    const opened = correlatedTerminalFixture("terminal-opened", request);
    await h.runtime.sendTerminalFrame({ ...authorityRoute }, opened);
    return { h, routeBinding, request, opened, authorityRoute };
  }

  await t.test("stream-scoped events omit host fields and retain exact stream lineage", async () => {
    const { h, opened, authorityRoute } = await openStream();
    for (const name of [
      "terminal-output",
      "terminal-input-ack",
      "terminal-input-error",
      "terminal-resize-ack",
      "terminal-resize-error",
    ]) {
      const event = fixture(name);
      event.streamId = opened.streamId;
      event.payload.generation = opened.payload.generation;
      assert.equal(Object.hasOwn(event, "hostId"), false);
      assert.equal(Object.hasOwn(event, "hostEpoch"), false);
      await h.runtime.sendTerminalFrame({ ...authorityRoute }, event);
    }
    const reset = fixture("terminal-reset-required-event");
    reset.streamId = opened.streamId;
    reset.payload.generation = opened.payload.generation;
    await h.runtime.sendTerminalFrame({ ...authorityRoute }, reset);
    assert.equal(h.state.sent.at(-1).frame.type, "terminal.reset_required");
    assert.equal(h.state.calls.unbind.length, 1);
    assert.equal(
      h.state.calls.unbind[0].route.runtimeBindingToken,
      authorityRoute.runtimeBindingToken,
    );

    const late = fixture("terminal-output");
    late.streamId = opened.streamId;
    late.payload.generation = opened.payload.generation;
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, late),
      /stale route binding/,
    );
  });

  await t.test("natural terminal.closed is a stream event and consumes no request", async () => {
    const { h, opened, authorityRoute } = await openStream();
    const closed = fixture("terminal-closed-event");
    closed.streamId = opened.streamId;
    closed.payload.generation = opened.payload.generation;
    await h.runtime.sendTerminalFrame({ ...authorityRoute }, closed);
    assert.equal(h.state.sent.at(-1).frame.kind, "event");
    assert.equal(h.state.sent.at(-1).frame.type, "terminal.closed");
  });

  await t.test("wrong token, tuple, lineage, or callback type is rejected", async () => {
    const { h, opened, authorityRoute } = await openStream();
    const output = fixture("terminal-output");
    output.streamId = opened.streamId;
    output.payload.generation = opened.payload.generation;
    await assert.rejects(
      h.runtime.sendTerminalFrame({
        ...authorityRoute,
        runtimeBindingToken: "forged-runtime-binding-token",
      }, output),
      /stale route binding/,
    );
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute, routeFence: "forged-fence" }, output),
      /stale route binding/,
    );
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, {
        ...output,
        payload: { ...output.payload, generation: "forged-generation" },
      }),
      /stream lineage/,
    );
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, fixture("sessions-changed-upsert")),
      /another authority's event/,
    );
  });

  await t.test("delayed close response survives H3 Promise completion and consumes once", async () => {
    const { h, routeBinding, opened } = await openStream();
    let closeRoute;
    h.terminals.close = async (request) => {
      h.state.calls.terminal.push({ method: "close", request: structuredClone(request) });
      closeRoute = request.route;
    };
    const close = fixture("terminal-close");
    close.expectedHostEpoch = HOST_EPOCH;
    close.streamId = opened.streamId;
    close.payload.generation = opened.payload.generation;
    close.payload.resumeToken = opened.payload.resumeToken;
    send(h.runtime, routeBinding, close);
    await settle(4);

    const response = correlatedTerminalFixture("terminal-closed-response", close);
    const wrong = structuredClone(response);
    wrong.payload.closeId = "wrong-close-owner";
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...closeRoute }, wrong),
      /close owner/,
    );
    await h.runtime.sendTerminalFrame({ ...closeRoute }, response);
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...closeRoute }, response),
      /not owned by a terminal request/,
    );
    assert.equal(h.state.sent.filter(({ frame }) => frame.requestId === close.requestId).length, 1);
  });
});

test("actual H3 correlated reset revokes the old token before late stream output", async () => {
  const actual = actualTerminalRuntimeHarness({ runtimeLimits: { maxRoutes: 1 } });
  const { h, manager, backend } = actual;
  try {
    const routeBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.hostId = HOST_ID;
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, open);
    await settle(12);
    const opened = h.state.sent.find(({ frame }) => frame.requestId === open.requestId)?.frame;
    assert.equal(opened.type, "terminal.opened");
    const oldBinding = h.state.calls.terminal.find(({ method }) => method === "open").request.route;

    const replay = fixture("terminal-replay-request");
    replay.requestId = "actual-reset-replay";
    replay.hostId = HOST_ID;
    replay.expectedHostEpoch = HOST_EPOCH;
    replay.streamId = opened.streamId;
    replay.payload.generation = "actual-stale-replay-generation";
    replay.payload.fromOffset = "0";
    send(h.runtime, routeBinding, replay);
    await settle(16);

    const reset = h.state.sent.find(({ frame }) => frame.requestId === replay.requestId)?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.origin, "replay");
    assert.equal(h.state.calls.unbind.length, 1);
    assert.equal(
      h.state.calls.unbind[0].route.runtimeBindingToken,
      oldBinding.runtimeBindingToken,
      "the reset must detach the exact old in-memory binding",
    );
    const beforeLateOutput = h.state.sent.length;
    await backend.opens[0].observer.onBytes(Buffer.from([1, 2, 3]));
    await settle(8);
    assert.equal(h.state.sent.length, beforeLateOutput);
    assert.equal(
      h.state.sent.some(({ frame }) => frame.type === "terminal.output"),
      false,
    );
    assert.deepEqual(h.state.closes, []);

    h.runtime.onRouteUnbound(routeBinding, "client_closed");
    await settle(8);
    const replacement = binding({
      routeId: "route-after-reset-drain",
      routeFence: "fence-after-reset-drain",
      connectionId: "connection-after-reset-drain",
      authContext: { jti: "jti-after-reset-drain" },
    });
    assert.equal(h.runtime.onRouteBound(replacement), undefined);
  } finally {
    h.runtime.dispose();
    await manager.shutdown();
  }
});

test("actual H3 async reset revokes its token before every late stream callback", async () => {
  const actual = actualTerminalRuntimeHarness({
    terminalLimits: {
      streamRingBytes: 8,
      hostRingBytes: 16,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
    },
  });
  const { h, manager, backend } = actual;
  try {
    const routeBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.hostId = HOST_ID;
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, open);
    await settle(12);
    const opened = h.state.sent.find(({ frame }) => frame.requestId === open.requestId)?.frame;
    assert.equal(opened.type, "terminal.opened");
    const oldBinding = h.state.calls.terminal.find(({ method }) => method === "open").request.route;
    const oversize = new Proxy({}, {
      get(_target, property) {
        if (property === "byteLength") return 5;
        throw new Error(`oversize callback read unexpected ${String(property)}`);
      },
    });

    await backend.opens[0].observer.onBytes(oversize);
    await settle(16);
    const reset = h.state.sent.find(({ frame }) => (
      frame.kind === "event" && frame.type === "terminal.reset_required"
    ))?.frame;
    assert.ok(reset);
    assert.equal(reset.streamId, opened.streamId);
    assert.equal(reset.payload.generation, opened.payload.generation);
    assert.equal(h.state.calls.unbind.length, 1);
    assert.equal(h.state.calls.unbind[0].route.runtimeBindingToken, oldBinding.runtimeBindingToken);

    const beforeLateCallbacks = h.state.sent.length;
    for (const name of [
      "terminal-output",
      "terminal-input-ack",
      "terminal-resize-ack",
      "terminal-closed-event",
    ]) {
      const late = fixture(name);
      late.streamId = opened.streamId;
      late.payload.generation = opened.payload.generation;
      await assert.rejects(
        h.runtime.sendTerminalFrame({ ...oldBinding }, late),
        /stale route binding/,
      );
    }
    assert.equal(h.state.sent.length, beforeLateCallbacks);
    assert.equal(backend.opens[0].handle.closeCalls, 1);
    assert.deepEqual(h.state.closes, []);
  } finally {
    h.runtime.dispose();
    await manager.shutdown();
  }
});

test("actual H3 durable mode=new retry correlates its retained generation and offset", async () => {
  let dropInitialOpened = true;
  const actual = actualTerminalRuntimeHarness({
    terminalSend: async (_route, frame, _lineage, deliver) => {
      if (dropInitialOpened && frame.type === "terminal.opened") {
        dropInitialOpened = false;
        return;
      }
      await deliver();
    },
  });
  const { h, manager, backend } = actual;
  try {
    const firstBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.hostId = HOST_ID;
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, firstBinding, open);
    await settle(12);
    assert.equal(
      h.state.sent.some(({ frame }) => frame.requestId === open.requestId),
      false,
      "the first correlated response is intentionally lost before runtime",
    );
    assert.equal(backend.opens.length, 1);

    h.runtime.onRouteUnbound(firstBinding, "client_closed");
    await settle(8);
    actual.advance(terminalManager.RELAY_V2_TERMINAL_DETACHED_LEASE_MS + 1);
    await manager.sweep();
    assert.equal(backend.opens[0].handle.closeCalls, 1);

    const rebound = binding({
      connectorGeneration: firstBinding.connectorGeneration + 1,
      routeId: "durable-new-retry-route",
      routeFence: "durable-new-retry-fence",
      connectionId: "durable-new-retry-connection",
      authContext: { jti: "durable-new-retry-jti" },
    });
    await ready(h, rebound);
    const retry = structuredClone(open);
    retry.requestId = "durable-new-retry-request";
    send(h.runtime, rebound, retry);
    await settle(16);

    const reset = h.state.sent.find(({ frame }) => frame.requestId === retry.requestId)?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.origin, "open");
    assert.equal(reset.payload.generation, "actual-authority-generation-1");
    assert.equal(reset.payload.requestedOffset, "0");
    assert.equal(backend.opens.length, 1, "durable exact retry must not create a second backend");
  } finally {
    h.runtime.dispose();
    await manager.shutdown();
  }
});

test("actual H3 durable mode=reset retry correlates the replacement generation", async () => {
  let dropResetOpened = true;
  const actual = actualTerminalRuntimeHarness({
    terminalSend: async (_route, frame, _lineage, deliver) => {
      if (dropResetOpened
        && frame.type === "terminal.opened"
        && frame.payload.disposition === "reset") {
        dropResetOpened = false;
        return;
      }
      await deliver();
    },
  });
  const { h, manager, backend } = actual;
  try {
    const firstBinding = await ready(h);
    const initialOpen = fixture("terminal-open-new");
    initialOpen.hostId = HOST_ID;
    initialOpen.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, firstBinding, initialOpen);
    await settle(12);
    const initial = h.state.sent.find(({ frame }) => frame.requestId === initialOpen.requestId)?.frame;
    assert.equal(initial.type, "terminal.opened");

    const resetOpen = fixture("terminal-open-resume");
    resetOpen.requestId = "durable-reset-first-request";
    resetOpen.hostId = HOST_ID;
    resetOpen.expectedHostEpoch = HOST_EPOCH;
    resetOpen.streamId = initial.streamId;
    resetOpen.payload.openId = "durable-reset-open-id";
    resetOpen.payload.mode = "reset";
    resetOpen.payload.resume.generation = initial.payload.generation;
    resetOpen.payload.resume.nextOffset = "0";
    resetOpen.payload.resume.resumeToken = initial.payload.resumeToken;
    send(h.runtime, firstBinding, resetOpen);
    await settle(16);
    assert.equal(
      h.state.sent.some(({ frame }) => frame.requestId === resetOpen.requestId),
      false,
      "the replacement terminal.opened is intentionally lost before runtime",
    );
    assert.equal(backend.opens.length, 2);
    assert.equal(backend.opens[0].handle.closeCalls, 1);

    h.runtime.onRouteUnbound(firstBinding, "client_closed");
    await settle(8);
    actual.advance(terminalManager.RELAY_V2_TERMINAL_DETACHED_LEASE_MS + 1);
    await manager.sweep();
    assert.equal(backend.opens[1].handle.closeCalls, 1);

    const rebound = binding({
      connectorGeneration: firstBinding.connectorGeneration + 1,
      routeId: "durable-reset-retry-route",
      routeFence: "durable-reset-retry-fence",
      connectionId: "durable-reset-retry-connection",
      authContext: { jti: "durable-reset-retry-jti" },
    });
    await ready(h, rebound);
    const retry = structuredClone(resetOpen);
    retry.requestId = "durable-reset-retry-request";
    send(h.runtime, rebound, retry);
    await settle(16);

    const reset = h.state.sent.find(({ frame }) => frame.requestId === retry.requestId)?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.origin, "open");
    assert.equal(reset.payload.generation, "actual-authority-generation-2");
    assert.equal(reset.payload.requestedOffset, "0");
    assert.equal(backend.opens.length, 2, "durable reset retry must not replace the backend twice");
  } finally {
    h.runtime.dispose();
    await manager.shutdown();
  }
});

test("actual H3 credit-blocked close keeps its request on the old route and replays once for retry", async () => {
  const actual = actualTerminalRuntimeHarness({
    terminalLimits: {
      streamRingBytes: 16,
      hostRingBytes: 32,
      maxUnackedBytes: 4,
      maxFrameBytes: 4,
    },
  });
  const { h, manager, backend, lineage } = actual;
  try {
    const firstBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.hostId = HOST_ID;
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, firstBinding, open);
    await settle(12);
    const opened = h.state.sent.find(({ frame }) => frame.requestId === open.requestId)?.frame;
    assert.equal(opened.type, "terminal.opened");
    await backend.opens[0].observer.onBytes(Buffer.from([1, 2, 3, 4]));
    await backend.opens[0].observer.onBytes(Buffer.from([5, 6, 7, 8]));

    const firstClose = fixture("terminal-close");
    firstClose.requestId = "actual-close-old-request";
    firstClose.hostId = HOST_ID;
    firstClose.expectedHostEpoch = HOST_EPOCH;
    firstClose.streamId = opened.streamId;
    firstClose.payload.generation = opened.payload.generation;
    firstClose.payload.resumeToken = opened.payload.resumeToken;
    send(h.runtime, firstBinding, firstClose);
    await settle(12);
    assert.equal(
      h.state.sent.some(({ frame }) => frame.requestId === firstClose.requestId),
      false,
    );
    assert.equal(backend.opens[0].handle.closeCalls, 1);

    h.runtime.onRouteUnbound(firstBinding, "client_closed");
    await settle(10);
    const secondBinding = binding({
      routeId: "actual-close-route-two",
      routeFence: "actual-close-fence-two",
      connectionId: "actual-close-connection-two",
      authContext: { jti: "actual-close-jti-two" },
    });
    await ready(h, secondBinding);
    const resume = fixture("terminal-open-resume");
    resume.requestId = "actual-close-resume";
    resume.hostId = HOST_ID;
    resume.expectedHostEpoch = HOST_EPOCH;
    resume.streamId = opened.streamId;
    resume.payload.openId = "actual-close-resume-open";
    resume.payload.resume.generation = opened.payload.generation;
    resume.payload.resume.nextOffset = "0";
    resume.payload.resume.resumeToken = opened.payload.resumeToken;
    send(h.runtime, secondBinding, resume);
    await settle(14);
    assert.equal(
      h.state.sent.some(({ binding: delivered, frame }) => (
        delivered === secondBinding && frame.requestId === firstClose.requestId
      )),
      false,
    );

    const retry = structuredClone(firstClose);
    retry.requestId = "actual-close-new-request";
    send(h.runtime, secondBinding, retry);
    await settle(8);
    const ack = fixture("terminal-output-ack");
    ack.streamId = opened.streamId;
    ack.payload.generation = opened.payload.generation;
    ack.payload.nextOffset = "4";
    send(h.runtime, secondBinding, ack);
    await settle(16);

    const responses = h.state.sent.filter(({ frame }) => frame.requestId === retry.requestId);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0].binding, secondBinding);
    assert.equal(responses[0].frame.type, "terminal.closed");
    assert.equal(responses[0].frame.payload.deduplicated, true);
    assert.equal(backend.opens[0].handle.closeCalls, 1);
    assert.equal(
      h.state.sent.some(({ frame }) => frame.kind === "event"
        && frame.type === "terminal.closed"
        && frame.payload.reason === "client_closed"),
      false,
    );
    assert.deepEqual(
      Reflect.ownKeys(lineage.claimCloseCalls[0].intent.requestRoute).sort(),
      ["connectorId", "routeFence", "routeId"],
    );
  } finally {
    h.runtime.dispose();
    await manager.shutdown();
  }
});

test("request ownership and response metadata fence cross-owner or retargeted frames", async (t) => {
  await t.test("openId and reset origin are exact terminal request metadata", async () => {
    let authorityRoute;
    const h = createHarness({
      terminal: async (method, request) => {
        if (method === "open") authorityRoute = request.route;
      },
    });
    const routeBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, open);
    await settle(3);

    const wrongOpen = correlatedTerminalFixture("terminal-opened", open);
    wrongOpen.payload.openId = "forged-open-id";
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongOpen),
      /openId owner/,
    );
    const wrongOrigin = correlatedTerminalFixture("terminal-reset-required-response", open);
    wrongOrigin.payload.origin = "replay";
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongOrigin),
      /wrong request origin/,
    );
    await h.runtime.sendTerminalFrame(
      { ...authorityRoute },
      correlatedTerminalFixture("terminal-opened", open),
    );
  });

  await t.test("terminal.open mode, generation, and offset truth table is exact", async () => {
    for (const mode of ["new", "resume", "reset"]) {
      let authorityRoute;
      const h = createHarness({
        terminal: async (method, request) => {
          if (method === "open") authorityRoute = request.route;
        },
      });
      const routeBinding = await ready(h);
      const open = fixture(mode === "new" ? "terminal-open-new" : "terminal-open-resume");
      open.requestId = `open-truth-table-${mode}`;
      open.expectedHostEpoch = HOST_EPOCH;
      open.payload.mode = mode;
      send(h.runtime, routeBinding, open);
      await settle(3);

      const validOpened = correlatedTerminalFixture("terminal-opened", open);
      const wrongDisposition = structuredClone(validOpened);
      wrongDisposition.payload.disposition = mode === "new" ? "resumed" : "new";
      await assert.rejects(
        h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongDisposition),
        /open mode lineage/,
      );
      const wrongReplayOffset = structuredClone(validOpened);
      wrongReplayOffset.payload.replayFromOffset = String(
        BigInt(validOpened.payload.replayFromOffset) + 1n,
      );
      await assert.rejects(
        h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongReplayOffset),
        /open mode lineage/,
      );
      if (mode === "resume") {
        const wrongGeneration = structuredClone(validOpened);
        wrongGeneration.payload.generation = "forged-resume-generation";
        await assert.rejects(
          h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongGeneration),
          /open mode lineage/,
        );
      } else if (mode === "reset") {
        const reusedGeneration = structuredClone(validOpened);
        reusedGeneration.payload.generation = open.payload.resume.generation;
        await assert.rejects(
          h.runtime.sendTerminalFrame({ ...authorityRoute }, reusedGeneration),
          /open mode lineage/,
        );
      }

      const reset = correlatedTerminalFixture("terminal-reset-required-response", open);
      if (mode === "new") {
        await assert.rejects(
          h.runtime.sendTerminalFrame({ ...authorityRoute }, reset, {
            owner: "terminal.open",
            requestId: open.requestId,
            openId: open.payload.openId,
            mode,
            generation: "forged-durable-generation",
            requestedOffset: "0",
          }),
          /durable open lineage/,
        );
      }
      const wrongResetGeneration = structuredClone(reset);
      wrongResetGeneration.payload.generation = reset.payload.generation === null
        ? "forged-reset-generation"
        : "different-reset-generation";
      await assert.rejects(
        h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongResetGeneration),
        /open reset crossed its generation or offset owner/,
      );
      const wrongRequestedOffset = structuredClone(reset);
      wrongRequestedOffset.payload.requestedOffset = reset.payload.requestedOffset === null
        ? "0"
        : String(BigInt(reset.payload.requestedOffset) + 1n);
      await assert.rejects(
        h.runtime.sendTerminalFrame({ ...authorityRoute }, wrongRequestedOffset),
        /open reset crossed its generation or offset owner/,
      );

      await h.runtime.sendTerminalFrame({ ...authorityRoute }, validOpened);
    }
  });

  await t.test("replay generation and fromOffset are exact request metadata", async () => {
    let authorityRoute;
    const h = createHarness({
      terminal: async (_method, request) => { authorityRoute = request.route; },
    });
    const routeBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, open);
    await settle(3);
    const opened = correlatedTerminalFixture("terminal-opened", open);
    await h.runtime.sendTerminalFrame({ ...authorityRoute }, opened);

    const replay = fixture("terminal-replay-request");
    replay.expectedHostEpoch = HOST_EPOCH;
    replay.streamId = opened.streamId;
    replay.payload.generation = opened.payload.generation;
    send(h.runtime, routeBinding, replay);
    await settle(3);
    const wrong = correlatedTerminalFixture("terminal-replay-started", replay);
    wrong.payload.fromOffset = String(BigInt(replay.payload.fromOffset) + 1n);
    await assert.rejects(
      h.runtime.sendTerminalFrame({ ...authorityRoute }, wrong),
      /generation or offset owner/,
    );
    await h.runtime.sendTerminalFrame(
      { ...authorityRoute },
      correlatedTerminalFixture("terminal-replay-started", replay),
    );
  });

  await t.test("H3 cannot borrow a pending command requestId", async () => {
    let finishCommand;
    let authorityRoute;
    const commandResult = new Promise((resolve) => { finishCommand = resolve; });
    const h = createHarness({
      execute: async () => commandResult,
      terminal: async (_method, request) => { authorityRoute = request.route; },
    });
    const routeBinding = await ready(h);
    const open = fixture("terminal-open-new");
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, open);
    await settle(3);
    assert.equal(typeof authorityRoute?.runtimeBindingToken, "string");
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, command);
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
      assert.equal(h.state.closes.at(-1).code, 1011);
    });
  }

  await t.test("generic error fields expected absent must also be absent", async () => {
    for (const [field, forged] of [
      ["commandId", "forged-optional-command"],
      ["scopeId", "forged-optional-scope"],
      ["sessionId", "forged-optional-session"],
      ["streamId", "forged-optional-stream"],
    ]) {
      const h = createHarness({
        query: async (_auth, request) => ({
          ...errorResponse(request),
          [field]: forged,
        }),
      });
      const routeBinding = await ready(h);
      const query = fixture("command-query");
      query.requestId = `generic-error-optional-${field}`;
      query.expectedHostEpoch = HOST_EPOCH;
      send(h.runtime, routeBinding, query);
      await settle(6);
      assert.equal(h.state.sent.some(({ frame }) => frame.requestId === query.requestId), false);
      assert.equal(h.state.closes.at(-1).code, 1011);
    }
  });
});

test("owner failures are redacted and EVENT_CURSOR_AHEAD retains exact protocol semantics", async (t) => {
  await t.test("an arbitrary H1 throw emits no invented command disposition or secret", async () => {
    const secret = "token-super-secret";
    const h = createHarness({ execute: async () => { throw new Error(`${secret}\nstack-material`); } });
    const routeBinding = await ready(h);
    const command = fixture("command-execute-send-agent-message");
    command.expectedHostEpoch = HOST_EPOCH;
    const queued = structuredClone(command);
    queued.requestId = "command-after-owner-throw";
    queued.commandId = "command-after-owner-throw-id";
    send(h.runtime, routeBinding, command);
    send(h.runtime, routeBinding, queued);
    await settle(6);

    assert.equal(h.state.calls.commandExecute.length, 1);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === command.requestId), false);
    assert.equal(h.state.sent.some(({ frame }) => frame.requestId === queued.requestId), false);
    assert.equal(JSON.stringify(h.state.sent).includes(secret), false);
    assert.equal(h.state.closes.at(-1).code, 1011);
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

  await t.test("convenience snapshot overflow preserves SNAPSHOT_TOO_LARGE guidance", async () => {
    const h = createHarness({
      scopesSnapshot: async () => {
        throw new resourceState.RelayV2MaterializedStateError(
          "SNAPSHOT_TOO_LARGE",
          "oversized authority message must be redacted",
          { useStateSnapshot: true },
        );
      },
    });
    const routeBinding = await ready(h);
    const request = fixture("scopes-snapshot-get");
    request.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, routeBinding, request);
    await settle(8);

    const response = h.state.sent.find(({ frame }) => frame.requestId === request.requestId)?.frame;
    assert.equal(response.type, "error");
    assert.equal(response.error.code, "SNAPSHOT_TOO_LARGE");
    assert.deepEqual({ ...response.error.details }, { useStateSnapshot: true });
    assert.equal(JSON.stringify(response).includes("oversized authority message"), false);
    assert.equal(h.state.closes.some(({ code }) => code === 4406), false);
  });

  await t.test("independently bundled snapshot spool errors keep their typed semantics", async () => {
    for (const code of ["SNAPSHOT_EXPIRED", "BUSY"]) {
      const secret = `independent-spool-${code}-must-not-leak`;
      const h = createHarness({
        stateSnapshotGet: async () => {
          throw new snapshotSpool.RelayV2StateSnapshotSpoolError(code, secret);
        },
      });
      const routeBinding = await ready(h);
      const request = fixture("state-snapshot-get-first");
      request.requestId = `independent-spool-${code.toLowerCase()}`;
      request.expectedHostEpoch = HOST_EPOCH;
      send(h.runtime, routeBinding, request);
      await settle(8);

      const response = h.state.sent.find(({ frame }) => frame.requestId === request.requestId)?.frame;
      assert.equal(response.type, "error");
      assert.equal(response.error.code, code);
      assert.equal(response.error.retryable, code === "BUSY");
      assert.equal(response.error.commandDisposition, "not_applicable");
      assert.equal(JSON.stringify(response).includes(secret), false);
      assert.equal(h.state.closes.some(({ code: closeCode }) => closeCode === 1011), false);
    }

    for (const [kind, makeFailure] of [
      ["error", (secret) => Object.assign(new Error(secret), {
        name: "RelayV2StateSnapshotSpoolError",
        code: "SNAPSHOT_EXPIRED",
        details: null,
      })],
      ["object", (secret) => ({
        name: "RelayV2StateSnapshotSpoolError",
        code: "SNAPSHOT_EXPIRED",
        details: null,
        message: secret,
      })],
    ]) {
      const secret = `unbranded-${kind}-spool-secret`;
      const h = createHarness({
        stateSnapshotGet: async () => { throw makeFailure(secret); },
      });
      const routeBinding = await ready(h);
      const request = fixture("state-snapshot-get-first");
      request.requestId = `unbranded-spool-${kind}`;
      request.expectedHostEpoch = HOST_EPOCH;
      send(h.runtime, routeBinding, request);
      await settle(8);

      assert.equal(h.state.sent.some(({ frame }) => frame.requestId === request.requestId), false);
      assert.equal(h.state.sent.some(({ frame }) => frame.error?.code === "SNAPSHOT_EXPIRED"), false);
      assert.equal(JSON.stringify(h.state.sent).includes(secret), false);
      assert.equal(h.state.closes.at(-1).code, 1011);
      assert.equal(h.state.closes.at(-1).reason, "authority_failure");
    }
  });
});

test("typed H3 negative outcomes become correlated redacted not_applicable errors", async (t) => {
  for (const code of [
    "BUSY",
    "INVALID_ARGUMENT",
    "PERMISSION_DENIED",
    "TERMINAL_OPEN_CONFLICT",
    "TERMINAL_STREAM_CONFLICT",
    "TERMINAL_CLOSE_CONFLICT",
    "TERMINAL_ROUTE_STALE",
  ]) {
    await t.test(code, async () => {
      const secret = `secret-owner-message-${code}`;
      const h = createHarness({
        terminal: async (method) => {
          if (method === "open") {
            throw new terminalManager.RelayV2TerminalManagerError(code, secret);
          }
        },
      });
      const routeBinding = await ready(h);
      const open = fixture("terminal-open-new");
      open.expectedHostEpoch = HOST_EPOCH;
      send(h.runtime, routeBinding, open);
      await settle(8);

      const response = h.state.sent.find(({ frame }) => frame.requestId === open.requestId)?.frame;
      assert.equal(response.type, "error");
      assert.equal(response.error.code, code);
      assert.equal(response.error.commandDisposition, "not_applicable");
      assert.equal(response.error.retryable, code === "BUSY");
      assert.equal(response.scopeId, open.scopeId);
      assert.equal(response.sessionId, open.sessionId);
      assert.equal(response.streamId, open.streamId);
      assert.equal(JSON.stringify(response).includes(secret), false);
      assert.equal(h.state.closes.some((close) => close.code === 1013), false);
    });
  }
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
    let eventSink;
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      trySend: () => true,
      hello: async ({ cut, buildWelcome }, sink) => {
        eventSink = sink;
        assert.equal(sink.enqueue(buildWelcome(cut)), true);
      },
    });
    await ready(h);
    const event = fixture("sessions-changed-upsert");
    event.hostId = HOST_ID;
    event.hostEpoch = HOST_EPOCH;
    assert.equal(eventSink.enqueue(event), false);
    eventSink.close(new resourceState.RelayV2MaterializedStateError(
      "BUSY",
      "actual H2 subscriber exhausted its outbound slot",
    ));
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
    let eventSink;
    const h = createHarness({
      testLimits: { maxOutboundFramesPerRoute: 1 },
      trySend: () => true,
      hello: async ({ cut, buildWelcome }, sink) => {
        eventSink = sink;
        assert.equal(sink.enqueue(buildWelcome(cut)), true);
      },
    });
    const routeBinding = await ready(h);
    const event = fixture("sessions-changed-upsert");
    event.hostId = HOST_ID;
    event.hostEpoch = HOST_EPOCH;
    assert.equal(eventSink.enqueue(event), false);
    eventSink.close(new resourceState.RelayV2MaterializedStateError(
      "BUSY",
      "actual H2 subscriber exhausted its outbound slot",
    ));
    assert.deepEqual(h.state.closes.at(-1).binding, routeBinding);
    assert.equal(h.state.closes.at(-1).reason, "slow_consumer");
  });
});

test("H2 events await bounded sequenced lineage validation before outbound", async () => {
  let eventSink;
  let holdIdentity = false;
  let releaseIdentity;
  let identityStarted;
  const identityGate = new Promise((resolve) => { releaseIdentity = resolve; });
  const started = new Promise((resolve) => { identityStarted = resolve; });
  const current = { hostEpoch: HOST_EPOCH, hostInstanceId: HOST_INSTANCE_ID };
  const h = createHarness({
    testLimits: { maxPendingOperationsPerRoute: 2 },
    trySend: () => true,
    currentIdentity: async () => {
      if (holdIdentity) {
        identityStarted();
        await identityGate;
      }
      return { ...current };
    },
    hello: async ({ cut, buildWelcome }, sink) => {
      eventSink = sink;
      const welcome = buildWelcome(cut);
      assert.equal(sink.enqueue(welcome), true);
      return welcome;
    },
  });
  const routeBinding = await ready(h);
  const sentBefore = h.state.sent.length;
  holdIdentity = true;
  const first = fixture("sessions-changed-upsert");
  first.hostId = HOST_ID;
  first.hostEpoch = HOST_EPOCH;
  const second = fixture("scopes-changed-upsert");
  second.hostId = HOST_ID;
  second.hostEpoch = HOST_EPOCH;
  const third = fixture("sessions-changed-delete");
  third.hostId = HOST_ID;
  third.hostEpoch = HOST_EPOCH;
  assert.equal(eventSink.enqueue(first), true);
  await started;
  assert.equal(eventSink.enqueue(second), true);
  assert.equal(eventSink.enqueue(third), false);
  current.hostEpoch = "replacement-host-epoch";
  releaseIdentity();
  await settle(8);

  assert.equal(h.state.sent.length, sentBefore);
  assert.equal(h.state.closes.at(-1).code, 4400);
});

test("per-route inbound sequencing preserves FIFO authority entry", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let inputCalls = 0;
  const h = createHarness({
    terminal: async (method) => {
      if (method !== "input") return;
      inputCalls += 1;
      if (inputCalls === 1) await firstGate;
    },
  });
  const routeBinding = await ready(h);
  const first = fixture("terminal-input");
  const second = structuredClone(first);
  second.payload.inputSeq = String(BigInt(first.payload.inputSeq) + 1n);
  send(h.runtime, routeBinding, first);
  send(h.runtime, routeBinding, second);
  await settle(4);
  assert.equal(inputCalls, 1);
  releaseFirst();
  await settle(6);
  assert.equal(inputCalls, 2);
});

test("unbound work and transport receipts retain a global draining route budget", async (t) => {
  await t.test("an unresolved authority call prevents route churn from escaping maxRoutes", async () => {
    let finishQuery;
    const queryResult = new Promise((resolve) => { finishQuery = resolve; });
    const h = createHarness({
      testLimits: { maxRoutes: 1 },
      query: async () => queryResult,
    });
    const first = await ready(h);
    const query = fixture("command-query");
    query.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, first, query);
    await settle(3);
    assert.equal(h.state.calls.commandQuery.length, 1);
    h.runtime.onRouteUnbound(first, "client_closed");

    const next = binding({
      connectorGeneration: 2,
      connectorId: "draining-connector-two",
      routeId: "draining-route-two",
      routeFence: "draining-fence-two",
      connectionId: "draining-connection-two",
      authContext: { jti: "draining-jti-two" },
    });
    assert.equal(h.runtime.onRouteBound(next).code, "BUSY");
    finishQuery(errorResponse(query));
    await settle(8);
    assert.equal(h.runtime.onRouteBound(next), undefined);
  });

  await t.test("transport ownership remains charged after unbind until receipt", async () => {
    let welcomeReceipt;
    const h = createHarness({
      testLimits: { maxRoutes: 1 },
      trySend: (_binding, _bytes, frame, receipt) => {
        if (frame.type === "host.welcome") welcomeReceipt = receipt;
        return true;
      },
    });
    const first = await ready(h);
    h.runtime.onRouteUnbound(first, "client_closed");
    const next = binding({
      connectorGeneration: 2,
      connectorId: "receipt-connector-two",
      routeId: "receipt-route-two",
      routeFence: "receipt-fence-two",
      connectionId: "receipt-connection-two",
      authContext: { jti: "receipt-jti-two" },
    });
    assert.equal(h.runtime.onRouteBound(next).code, "BUSY");
    welcomeReceipt.settle(true);
    await settle(6);
    assert.equal(h.runtime.onRouteBound(next), undefined);
  });

  await t.test("an H3 serializer identity lookup remains in the draining registry", async () => {
    let holdIdentity = false;
    let releaseIdentity;
    let identityStarted;
    const gate = new Promise((resolve) => { releaseIdentity = resolve; });
    const started = new Promise((resolve) => { identityStarted = resolve; });
    let authorityRoute;
    const h = createHarness({
      testLimits: { maxRoutes: 1 },
      currentIdentity: async () => {
        if (holdIdentity) {
          identityStarted();
          await gate;
        }
        return { hostEpoch: HOST_EPOCH, hostInstanceId: HOST_INSTANCE_ID };
      },
      terminal: async (method, request) => {
        if (method === "open") authorityRoute = request.route;
      },
    });
    const first = await ready(h);
    const open = fixture("terminal-open-new");
    open.expectedHostEpoch = HOST_EPOCH;
    send(h.runtime, first, open);
    await settle(3);
    holdIdentity = true;
    const callback = h.runtime.sendTerminalFrame(
      { ...authorityRoute },
      correlatedTerminalFixture("terminal-opened", open),
    );
    await started;
    h.runtime.onRouteUnbound(first, "client_closed");
    const next = binding({
      connectorGeneration: 2,
      connectorId: "serializer-connector-two",
      routeId: "serializer-route-two",
      routeFence: "serializer-fence-two",
      connectionId: "serializer-connection-two",
      authContext: { jti: "serializer-jti-two" },
    });
    assert.equal(h.runtime.onRouteBound(next).code, "BUSY");
    releaseIdentity();
    await assert.rejects(callback, /lost its route fence/);
    await settle(6);
    assert.equal(h.runtime.onRouteBound(next), undefined);
  });

  for (const failure of ["reject", "throw"]) {
    await t.test(`H3 unbind ${failure} quarantines its draining slot without retry`, async () => {
      const h = createHarness({ testLimits: { maxRoutes: 1 } });
      const first = await ready(h);
      h.terminals.unbind = (auth, route) => {
        h.state.calls.unbind.push({ auth: structuredClone(auth), route: structuredClone(route) });
        if (failure === "throw") throw new Error("synchronous unbind failure");
        return Promise.reject(new Error("asynchronous unbind failure"));
      };
      h.runtime.onRouteUnbound(first, "client_closed");
      await settle(6);

      const next = binding({
        connectorGeneration: 2,
        connectorId: `unbind-${failure}-connector-two`,
        routeId: `unbind-${failure}-route-two`,
        routeFence: `unbind-${failure}-fence-two`,
        connectionId: `unbind-${failure}-connection-two`,
        authContext: { jti: `unbind-${failure}-jti-two` },
      });
      assert.equal(h.runtime.onRouteBound(next).code, "BUSY");
      assert.equal(h.state.calls.unbind.length, 1);
      assert.equal(h.state.closes.at(-1).code, 1011);
      assert.equal(h.state.closes.at(-1).reason, "authority_failure");
      await settle(8);
      assert.equal(h.state.calls.unbind.length, 1, "unbind failure must not start an unbounded retry");
      assert.equal(h.runtime.onRouteBound(next).code, "BUSY");
    });
  }
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
  let runtime;
  try {
    const store = await hostState.RelayV2HostStateStore.open({ home });
    const now = 1_783_700_000_000;
    const h1 = await commandPlane.RelayV2HostCommandPlane.open({
      store,
      hostId: HOST_ID,
      recover: false,
      now: () => now,
      executor: {
        async resolve(request) {
          return {
            kind: "immutable_business_failure",
            authorityEvidence: {
              schemaVersion: commandPlane.RELAY_V2_COMMAND_AUTHORITY_EVIDENCE_SCHEMA_VERSION,
              coverage: "complete",
              authority: request.authority,
              hostId: request.hostId,
              hostEpoch: request.hostEpoch,
              scopeId: request.scopeId,
              sessionId: request.sessionId,
              evidence: { source: "actual-port-test-authority" },
            },
            error: {
              code: "SESSION_NOT_FOUND",
              message: "Actual command authority found no retained Session",
              retryable: false,
              commandDisposition: "completed",
              details: null,
            },
          };
        },
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
      lineage: {
        async claimOpen(claim) {
          return {
            status: "replay",
            outcome: {
              kind: "reset",
              generation: claim.previousGeneration,
              reason: "stream_lost",
              requestedOffset: claim.requestedOffset,
              bufferStartOffset: null,
              tailOffset: null,
            },
          };
        },
        async releaseStreamReservation() {
          return { status: "already_released" };
        },
      },
      backend: {},
      terminalControl: {},
      send: async (route, frame, responseLineage) => runtime.sendTerminalFrame(
        { ...route },
        frame,
        responseLineage === undefined ? undefined : { ...responseLineage },
      ),
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
    runtime = new runtimeModule.RelayV2HostRuntime({
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
    const execute = fixture("command-execute-kill-session");
    execute.hostId = HOST_ID;
    execute.expectedHostEpoch = reconciled.snapshot.hostEpoch;
    execute.payload.dedupeWindowId = welcome.payload.commandDedupeWindow.windowId;
    send(runtime, routeBinding, execute);
    await settle(12);
    const commandStatus = sent.find(({ frame }) => frame.requestId === execute.requestId)?.frame;
    assert.equal(commandStatus.type, "command.status");
    assert.equal(commandStatus.payload.state, "failed");
    assert.equal(commandStatus.error.code, "SESSION_NOT_FOUND");

    const query = fixture("command-query");
    query.hostId = HOST_ID;
    query.expectedHostEpoch = reconciled.snapshot.hostEpoch;
    query.payload.items = [{
      commandId: execute.commandId,
      dedupeWindowId: welcome.payload.commandDedupeWindow.windowId,
    }];
    send(runtime, routeBinding, query);
    await settle(10);
    const statuses = sent.find(({ frame }) => frame.requestId === query.requestId)?.frame;
    assert.equal(statuses.type, "command.statuses");
    assert.equal(statuses.payload.items[0].state, "failed");
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

    const terminalOpen = fixture("terminal-open-new");
    terminalOpen.hostId = HOST_ID;
    terminalOpen.expectedHostEpoch = reconciled.snapshot.hostEpoch;
    send(runtime, routeBinding, terminalOpen);
    await settle(12);
    const reset = sent.find(({ frame }) => frame.requestId === terminalOpen.requestId)?.frame;
    assert.equal(reset.type, "terminal.reset_required");
    assert.equal(reset.payload.origin, "open");
    assert.deepEqual(closes, []);
    runtime.onRouteUnbound(routeBinding, "client_closed");
    runtime.dispose();
  } finally {
    await h3?.shutdown();
    await spool?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a misrouted v1 dialect returns the typed rejection consumed as route.rejected", () => {
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
  assert.deepEqual(h.runtime.onRouteBound(legacyBinding), {
    accepted: false,
    code: "HOST_DIALECT_UNAVAILABLE",
    message: "Requested Relay dialect is unavailable",
    retryable: false,
  });
  assert.equal(h.state.closes.length, 0);
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
