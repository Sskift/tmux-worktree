import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const brokerModule = await import("../dist/relay/v2/brokerCore.js");
const carrierModule = await import("../dist/relay/v2/hostCarrier.js");
const pumpModule = await import("../dist/relay/v2/carrierPump.js");
const codec = await import("../dist/relay/v2/codec.js");

const HOST_ID = "mac-admin";

class ManualScheduler {
  now = 1_783_700_000_000;
  tasks = [];

  schedule = (delayMs, callback) => {
    const task = {
      at: this.now + delayMs,
      callback,
      cancelled: false,
      order: this.tasks.length,
    };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };

  async flushReady(limit = 2_000) {
    for (let turn = 0; turn < limit; turn += 1) {
      const ready = this.tasks
        .filter((task) => !task.cancelled && task.at <= this.now)
        .sort((left, right) => left.at - right.at || left.order - right.order)[0];
      if (ready) {
        ready.cancelled = true;
        ready.callback();
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      await new Promise((resolve) => setImmediate(resolve));
      const afterMicrotasks = this.tasks.some((task) => (
        !task.cancelled && task.at <= this.now
      ));
      if (!afterMicrotasks) return;
    }
    throw new Error("manual Relay v2 scheduler did not settle");
  }

  async advance(milliseconds) {
    this.now += milliseconds;
    await this.flushReady();
  }

  liveDelayedTasks() {
    return this.tasks.filter((task) => !task.cancelled && task.at > this.now);
  }
}

class FakeCredentials {
  read(reference) {
    return {
      reference,
      version: "1",
      grantId: "host-grant",
      accessJti: "host-access-jti",
      accessToken: "twcap2.fake-host-access.mac",
    };
  }

  acknowledgeReauthentication() {
    return true;
  }
}

function authContext(role, now) {
  return {
    scheme: "twcap2",
    role,
    hostId: HOST_ID,
    principalId: role === "host" ? "host-principal" : "client-principal",
    grantId: role === "host" ? "host-grant" : "client-grant",
    clientInstanceId: role === "host" ? null : "android-install",
    jti: role === "host" ? "host-access-jti" : `client-${randomUUID()}`,
    kid: "key-2026-07",
    expiresAtMs: now + 3_600_000,
  };
}

function publicClientFrame(streamId) {
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.output_ack",
    streamId,
    payload: { generation: "generation-1", nextOffset: "0" },
  });
}

function publicHostFrame(streamId) {
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "event",
    type: "terminal.input_ack",
    streamId,
    payload: { generation: "generation-1", ackedThroughInputSeq: "0" },
  });
}

function sessionsSnapshotRequest(requestId, hostEpoch) {
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "request",
    type: "sessions.snapshot.get",
    requestId,
    hostId: HOST_ID,
    expectedHostEpoch: hostEpoch,
    payload: { scopeIds: ["scope-large"] },
  });
}

function sessionsSnapshotResponse(requestId, hostEpoch, cwdBytes) {
  // U+0001 is a legal non-NUL Unix path byte and is admitted by the frozen
  // public schema. JSON escaping makes the wire approach 1 MiB while 80
  // sessions stay below the public 1,024-key and 4,096-node parse budgets.
  const cwd = `/${"\u0001".repeat(cwdBytes - 1)}`;
  const items = Array.from({ length: 80 }, (_, index) => ({
    scopeId: "scope-large",
    sessionId: `session-large-${index}`,
    kind: "worktree",
    displayName: `large-${index}`,
    state: "running",
    project: "large",
    label: null,
    cwd,
    attached: false,
    windowCount: 1,
    createdAtMs: 1_783_700_000_000,
    activityAtMs: 1_783_700_000_000,
  }));
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "response",
    type: "sessions.snapshot",
    requestId,
    hostId: HOST_ID,
    hostEpoch,
    payload: {
      coverageComplete: false,
      throughEventSeq: null,
      scopes: [{
        scopeId: "scope-large",
        revision: "7",
        completeness: "complete",
        items,
        error: null,
      }],
    },
  });
}

function largestSessionsSnapshot(requestId, hostEpoch) {
  let low = 1;
  let high = 4_096;
  let selected;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    try {
      const encoded = sessionsSnapshotResponse(requestId, hostEpoch, middle);
      selected = { cwdBytes: middle, encoded };
      low = middle + 1;
    } catch {
      high = middle - 1;
    }
  }
  assert.ok(selected);
  return selected;
}

function carrierFrame(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function decodedCarrier(bytes) {
  return codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
}

function createHarness(options = {}) {
  const scheduler = new ManualScheduler();
  const hostEpoch = options.hostEpoch ?? randomUUID();
  const broker = options.broker ?? new brokerModule.RelayV2BrokerCore({
    now: () => scheduler.now,
    ...options.brokerOptions,
  });
  const statusObservations = [];
  const eventLog = [];
  const bound = [];
  const received = [];
  const unbound = [];
  const brokerActions = [];
  const forcedBrokerActions = [];
  const host = new carrierModule.RelayV2HostCarrierActor({
    hostId: options.hostId ?? HOST_ID,
    hostEpoch,
    hostInstanceId: options.hostInstanceId ?? randomUUID(),
    credentialReferences: new FakeCredentials(),
    advertisedCapabilities: [...brokerModule.RELAY_V2_REQUIRED_CAPABILITIES],
    clientDialects: ["tw-relay.v2"],
    clock: () => scheduler.now,
    schedule: scheduler.schedule,
    queueLimits: options.hostQueueLimits,
    routeSink: {
      onRouteBound(binding) {
        bound.push(binding);
      },
      onClientFrame(binding, payload) {
        received.push({ binding, payload: Uint8Array.from(payload) });
      },
      onRouteUnbound(binding, reason) {
        unbound.push({ binding, reason });
      },
    },
    onStatus(status) {
      eventLog.push(`status:${status.phase}:${status.closeCode ?? "none"}`);
      statusObservations.push({
        status,
        directoryAtStatus: broker.inspectHost(HOST_ID),
      });
    },
  });
  const pump = new pumpModule.RelayV2BrokerHostCarrierPump({
    broker,
    host,
    transportId: options.transportId ?? "carrier-transport",
    hostAuthContext: options.hostAuthContext ?? authContext("host", scheduler.now),
    credentialReference: "host-credential",
    now: () => scheduler.now,
    schedule: scheduler.schedule,
    queueLimits: options.queueLimits,
    deliveryTimeoutMs: options.deliveryTimeoutMs,
    onBrokerAction(action, signal, fence) {
      brokerActions.push(action);
      return options.actionSink?.(action, signal, fence);
    },
    onForceBrokerAction(action, fence) {
      forcedBrokerActions.push(action);
      return options.forceActionSink
        ? options.forceActionSink(action, fence)
        : true;
    },
  });
  return {
    scheduler,
    broker,
    host,
    pump,
    statusObservations,
    eventLog,
    bound,
    received,
    unbound,
    brokerActions,
    forcedBrokerActions,
    transportId: options.transportId ?? "carrier-transport",
    hostEpoch,
  };
}

async function startRegistered(harness) {
  const connection = harness.pump.start();
  await harness.scheduler.flushReady();
  assert.equal(harness.host.status().phase, "registered");
  assert.equal(harness.broker.inspectHost(HOST_ID).state, "online");
  assert.deepEqual(harness.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  return connection;
}

async function openRoute(harness, connectionId) {
  const result = harness.broker.openClientRoute(
    connectionId,
    authContext("client", harness.scheduler.now),
  );
  assert.equal(result.accepted, true);
  harness.pump.acceptBrokerResult(result);
  await harness.scheduler.flushReady();
  const binding = harness.bound.find((candidate) => candidate.connectionId === connectionId);
  assert.ok(binding);
  assert.equal(harness.brokerActions.some((action) => (
    action.kind === "route_opened" && action.connectionId === connectionId
  )), true);
  return binding;
}

function acceptClientDelivery(harness, delivery) {
  const result = harness.broker.acknowledgeClientDelivery(
    delivery.connectionId,
    delivery.deliveryId,
  );
  assert.equal(result.accepted, true);
  harness.pump.acceptBrokerResult(result);
}

function observeCarrierReceives(harness) {
  const connect = harness.host.connect.bind(harness.host);
  harness.host.connect = (transport, credentialReference) => {
    const connection = connect(transport, credentialReference);
    return Object.freeze({
      ...connection,
      receive(bytes, metadata) {
        harness.eventLog.push(`receive:${decodedCarrier(bytes).type}`);
        connection.receive(bytes, metadata);
      },
    });
  };
}

function settleActionAfter(scheduler, signal, delayMs, effect, rejectEffect = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancel = () => {};
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cancel();
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("action aborted")));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = scheduler.schedule(delayMs, () => finish(() => {
      if (rejectEffect) {
        reject(new Error("action rejected"));
        return;
      }
      effect();
      resolve();
    }));
  });
}

class StatefulBrokerActionOwner {
  sockets = new Map();
  permanentlyFenced = new Set();
  effects = [];
  rejectedEffects = [];
  forceCalls = [];

  trackClient(connectionId) {
    this.sockets.set(`client:${connectionId}`, true);
  }

  isOpen(connectionId) {
    return this.sockets.get(`client:${connectionId}`) === true;
  }

  apply(action, fence) {
    if (action.kind === "route_opened") {
      if (this.permanentlyFenced.has(fence.identity) || !fence.mayApply()) {
        this.rejectedEffects.push(`route_opened:${action.connectionId}`);
        return false;
      }
      this.sockets.set(fence.identity, true);
      this.effects.push(`route_opened:${action.connectionId}`);
      return true;
    }
    if (action.kind === "close_client" || action.kind === "route_unavailable") {
      this.permanentlyFenced.add(fence.identity);
      this.sockets.set(fence.identity, false);
      this.effects.push(`${action.kind}:${action.connectionId}`);
      return true;
    }
    if (action.kind === "close_host") {
      this.permanentlyFenced.add(fence.identity);
      this.effects.push(`close_host:${action.transportId}`);
      return true;
    }
    this.effects.push(action.kind);
    return true;
  }

  force(action, fence) {
    this.forceCalls.push(`${action.kind}:${fence.identity}:${fence.generation}`);
    // This is the socket owner's irreversible fence. It is installed before
    // the close effect and remains after the pump releases all of its state.
    this.permanentlyFenced.add(fence.identity);
    return this.apply(action, fence) === true;
  }
}

test("start attach failures roll back to a settled terminal receipt", async (t) => {
  await t.test("duplicate transport leaves the existing production carrier intact", async () => {
    const first = createHarness({ transportId: "start-duplicate-transport" });
    await startRegistered(first);
    const duplicate = createHarness({
      broker: first.broker,
      transportId: first.transportId,
    });

    assert.throws(() => duplicate.pump.start());
    assert.deepEqual(await duplicate.pump.whenCloseSettled(), {
      outcome: "closed",
      code: 1013,
      reason: "carrier_pump_start_failure",
      failedMandatoryActions: 0,
    });
    assert.equal(duplicate.pump.snapshot().phase, "closed");
    assert.equal(duplicate.pump.snapshot().scheduledTimers, 0);
    assert.equal(first.broker.inspectHost(HOST_ID).state, "online");
    assert.equal(first.host.status().phase, "registered");
    first.pump.shutdown();
    await first.scheduler.flushReady();
  });

  await t.test("invalid host auth cannot leave a running pump or hanging barrier", async () => {
    const h = createHarness({
      transportId: "start-invalid-auth",
      hostAuthContext: authContext("client", 1_783_700_000_000),
    });

    assert.throws(() => h.pump.start());
    const receipt = await h.pump.whenCloseSettled();
    assert.equal(receipt.outcome, "closed");
    assert.equal(receipt.reason, "carrier_pump_start_failure");
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
    assert.equal(h.broker.inspectHost(HOST_ID), undefined);
  });
});

test("registration commit, response retry, exact bidirectional bytes, ACKs and unbind cross production cores", async () => {
  const h = createHarness();
  let trySendDepth = 0;
  let maxTrySendDepth = 0;
  const attempts = [];
  const originalTrySend = h.pump.trySend.bind(h.pump);
  h.pump.trySend = (bytes, token) => {
    trySendDepth += 1;
    maxTrySendDepth = Math.max(maxTrySendDepth, trySendDepth);
    let type = "malformed";
    try { type = decodedCarrier(bytes).type; } catch {}
    const accepted = originalTrySend(bytes, token);
    attempts.push({ type, token, bytes: Uint8Array.from(bytes), accepted });
    trySendDepth -= 1;
    return accepted;
  };

  const connection = h.pump.start();
  assert.equal(h.broker.inspectHost(HOST_ID), undefined);
  assert.equal(h.host.status().phase, "connecting");
  assert.equal(h.pump.snapshot().hostToBroker.frames, 1);
  await h.scheduler.flushReady();

  const registeredObservation = h.statusObservations.find((entry) => (
    entry.status.phase === "registered"
  ));
  assert.ok(registeredObservation);
  assert.equal(
    registeredObservation.directoryAtStatus,
    undefined,
    "host.registered must reach HostCarrier before broker directory commit",
  );
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  assert.equal(maxTrySendDepth, 1, "transport acceptance never synchronously ACK-reenters trySend");

  h.pump.setWritable("host_to_broker", false);
  const open = h.broker.openClientRoute(
    "client-main",
    authContext("client", h.scheduler.now),
  );
  assert.equal(open.accepted, true);
  h.pump.acceptBrokerResult(open);
  await h.scheduler.flushReady();
  assert.equal(h.bound.length, 1);
  assert.equal(h.brokerActions.some((action) => action.kind === "route_opened"), false);

  h.pump.setWritable("host_to_broker", true);
  await h.scheduler.flushReady();
  const openedAttempts = attempts.filter((entry) => entry.type === "route.opened");
  assert.ok(openedAttempts.length >= 2);
  assert.equal(openedAttempts[0].accepted, false);
  assert.equal(openedAttempts.at(-1).accepted, true);
  assert.equal(openedAttempts[0].token, openedAttempts.at(-1).token);
  assert.deepEqual(openedAttempts[0].bytes, openedAttempts.at(-1).bytes);
  assert.equal(h.brokerActions.some((action) => (
    action.kind === "route_opened" && action.connectionId === "client-main"
  )), true);

  const binding = h.bound[0];
  const clientBytes = publicClientFrame("client-to-host-exact");
  const forwarded = h.broker.forwardClientFrame("client-main", clientBytes);
  assert.equal(forwarded.accepted, true);
  h.pump.acceptBrokerResult(forwarded);
  await h.scheduler.flushReady();
  assert.deepEqual(h.received.at(-1).payload, clientBytes);

  const hostBytes = publicHostFrame("host-to-client-exact");
  assert.equal(h.host.sendPublic(binding, hostBytes), true);
  await h.scheduler.flushReady();
  const [clientDelivery] = h.broker.drainClient("client-main", { maxFrames: 1 });
  assert.ok(clientDelivery);
  assert.deepEqual(Buffer.from(clientDelivery.bytes), Buffer.from(hostBytes));
  acceptClientDelivery(h, clientDelivery);
  await h.scheduler.flushReady();

  const unbinding = h.broker.unbindClient("client-main", "client_closed");
  assert.equal(unbinding.accepted, true);
  h.pump.acceptBrokerResult(unbinding);
  await h.scheduler.flushReady();
  assert.equal(h.unbound.at(-1).reason, "client_closed");
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  assert.equal(
    h.broker.forwardClientFrame("client-main", clientBytes).accepted,
    false,
    "matching route.unbound watermarks let broker retire the route",
  );
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });

  const closeBarrier = h.pump.shutdown();
  await h.scheduler.flushReady();
  assert.equal((await closeBarrier).outcome, "closed");
  await h.scheduler.flushReady();
  assert.equal(connection.generation, 1);
  assert.equal(h.pump.snapshot().phase, "closed");
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  assert.equal(h.scheduler.liveDelayedTasks().length, 0);
});

test("pressure rejection retains one frame until real low-water resume while another route stays fair", async () => {
  const h = createHarness();
  await startRegistered(h);
  const routeA = await openRoute(h, "client-a");
  const routeB = await openRoute(h, "client-b");

  for (let index = 1; index <= brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    assert.equal(h.host.sendPublic(routeA, publicHostFrame(`a-${index}`)), true);
    await h.scheduler.flushReady();
  }
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [routeA.routeId]);

  const pausedAttempts = [];
  const trySend = h.pump.trySend.bind(h.pump);
  h.pump.trySend = (bytes, token) => {
    const frame = decodedCarrier(bytes);
    const accepted = trySend(bytes, token);
    if (frame.type === "route.data" && frame.routeId === routeA.routeId) {
      pausedAttempts.push({ accepted, token, bytes: Uint8Array.from(bytes) });
    }
    return accepted;
  };
  const retainedBytes = publicHostFrame("a-retained-129");
  assert.equal(h.host.sendPublic(routeA, retainedBytes), true);
  await h.scheduler.flushReady();
  assert.equal(pausedAttempts.at(-1).accepted, false);
  assert.equal(
    h.pump.snapshot().hostToBroker.frames,
    0,
    "paused route data remains Host-owned until an explicit resume writable edge",
  );

  // Simulate a premature writable edge. The production broker still rejects
  // the same seq under pressure, and the pump must retain the exact delivery.
  h.pump.acceptBrokerResult({
    accepted: true,
    actions: [{
      kind: "resume_host_route",
      transportId: h.transportId,
      routeId: routeA.routeId,
    }],
  });
  await h.scheduler.flushReady();
  assert.equal(h.pump.snapshot().hostToBroker.frames, 1);
  assert.equal(pausedAttempts.at(-1).accepted, true);
  assert.equal(pausedAttempts[0].token, pausedAttempts.at(-1).token);
  assert.deepEqual(pausedAttempts[0].bytes, pausedAttempts.at(-1).bytes);
  const retainedSize = h.pump.snapshot().hostToBroker.bytes;
  assert.ok(retainedSize > retainedBytes.byteLength);
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [routeA.routeId]);

  const routeBBytes = publicHostFrame("b-fair-1");
  assert.equal(h.host.sendPublic(routeB, routeBBytes), true);
  await h.scheduler.flushReady();
  const [routeBDelivery] = h.broker.drainClient("client-b", { maxFrames: 1 });
  assert.ok(routeBDelivery, "a pressured route must not starve another route");
  assert.deepEqual(Buffer.from(routeBDelivery.bytes), Buffer.from(routeBBytes));
  acceptClientDelivery(h, routeBDelivery);

  const releases = h.broker.drainClient("client-a", { maxFrames: 65 });
  assert.equal(releases.length, 65);
  let sawRealResume = false;
  for (const delivery of releases) {
    const result = h.broker.acknowledgeClientDelivery("client-a", delivery.deliveryId);
    sawRealResume ||= result.actions.some((action) => action.kind === "resume_host_route");
    h.pump.acceptBrokerResult(result);
  }
  assert.equal(sawRealResume, true);
  await h.scheduler.flushReady();

  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, []);
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  const remaining = h.broker.drainClient("client-a");
  assert.deepEqual(Buffer.from(remaining.at(-1).bytes), Buffer.from(retainedBytes));
  for (const delivery of remaining) acceptClientDelivery(h, delivery);
  await h.scheduler.flushReady();

  h.pump.acceptBrokerResult(h.broker.unbindClient("client-a"));
  h.pump.acceptBrokerResult(h.broker.unbindClient("client-b"));
  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
});

test("rejecting a pending head immediately wakes ACK for a completed healthy tail", async () => {
  const h = createHarness();
  const outstanding = new Map();
  const acknowledged = [];
  const rejected = [];
  const trySend = h.pump.trySend.bind(h.pump);
  h.pump.trySend = (bytes, token) => {
    const accepted = trySend(bytes, token);
    if (accepted) outstanding.set(token, decodedCarrier(bytes));
    return accepted;
  };
  const connect = h.host.connect.bind(h.host);
  h.host.connect = (transport, credentialReference) => {
    const connection = connect(transport, credentialReference);
    return Object.freeze({
      ...connection,
      acknowledge(token) {
        acknowledged.push(outstanding.get(token));
        outstanding.delete(token);
        connection.acknowledge(token);
      },
      rejectUnaccepted(token) {
        rejected.push(outstanding.get(token));
        outstanding.delete(token);
        connection.rejectUnaccepted(token);
      },
    });
  };

  await startRegistered(h);
  const pressured = await openRoute(h, "client-rejected-head");
  const healthy = await openRoute(h, "client-completed-tail");
  assert.equal(outstanding.size, 0);
  for (let index = 0; index < brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    assert.equal(h.host.sendPublic(
      pressured,
      publicHostFrame(`rejected-head-fill-${index}`),
    ), true);
    await h.scheduler.flushReady();
  }
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [pressured.routeId]);
  assert.equal(outstanding.size, 0);

  assert.equal(h.host.sendPublic(pressured, publicHostFrame("rejected-head")), true);
  h.pump.acceptBrokerResult({
    accepted: true,
    actions: [{
      kind: "resume_host_route",
      transportId: h.transportId,
      routeId: pressured.routeId,
    }],
  });
  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [pressured.routeId]);
  assert.equal(outstanding.size, 1);

  assert.equal(h.host.sendPublic(healthy, publicHostFrame("completed-healthy-tail")), true);
  await h.scheduler.flushReady();
  assert.equal(outstanding.size, 2);
  assert.equal(h.pump.snapshot().hostToBroker.frames, 2);

  h.pump.acceptBrokerResult(h.broker.unbindClient("client-rejected-head", "client_closed"));
  await h.scheduler.flushReady();

  assert.equal(rejected.some((frame) => (
    frame?.type === "route.data" && frame.routeId === pressured.routeId
  )), true);
  assert.equal(acknowledged.some((frame) => (
    frame?.type === "route.data" && frame.routeId === healthy.routeId
  )), true);
  assert.equal(outstanding.size, 0, "HostCarrier socket-unconfirmed tokens are fully released");
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.equal(h.pump.snapshot().phase, "running");
  assert.equal(h.scheduler.liveDelayedTasks().length, 0);
});

test("per-route control cannot overtake already transport-owned data", async () => {
  const h = createHarness();
  await startRegistered(h);
  await openRoute(h, "client-ordered-close");
  h.pump.setWritable("broker_to_host", false);

  const data = publicClientFrame("ordered-before-unbind");
  const forwarded = h.broker.forwardClientFrame("client-ordered-close", data);
  assert.equal(forwarded.accepted, true);
  h.pump.acceptBrokerResult(forwarded);
  await h.scheduler.flushReady();
  assert.equal(h.pump.snapshot().brokerToHost.frames, 1);

  const unbinding = h.broker.unbindClient("client-ordered-close", "client_closed");
  assert.equal(unbinding.accepted, true);
  h.pump.acceptBrokerResult(unbinding);
  await h.scheduler.flushReady();
  assert.equal(h.pump.snapshot().brokerToHost.frames, 2);

  h.pump.setWritable("broker_to_host", true);
  await h.scheduler.flushReady();
  assert.deepEqual(h.received.at(-1).payload, data);
  assert.equal(h.unbound.at(-1).reason, "client_closed");
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
});

test("client unbind fences pump-owned reverse data without killing a healthy route", async (t) => {
  await t.test("pending Host data is rejected before route.unbind reaches Host", async () => {
    const h = createHarness();
    await startRegistered(h);
    const closing = await openRoute(h, "client-unbind-pending");
    const healthy = await openRoute(h, "client-unbind-pending-healthy");
    const stale = publicHostFrame("pending-before-client-close");

    assert.equal(h.host.sendPublic(closing, stale), true);
    assert.equal(h.pump.snapshot().hostToBroker.frames, 1);
    const unbinding = h.broker.unbindClient("client-unbind-pending", "client_closed");
    assert.equal(unbinding.accepted, true);
    h.pump.acceptBrokerResult(unbinding);
    await h.scheduler.flushReady();

    assert.equal(h.unbound.some((entry) => (
      entry.binding.connectionId === "client-unbind-pending"
        && entry.reason === "client_closed"
    )), true);
    assert.equal(h.broker.drainClient("client-unbind-pending").length, 0);
    assert.equal(h.pump.snapshot().phase, "running");
    assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
    assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });

    const healthyBytes = publicHostFrame("healthy-after-pending-unbind");
    assert.equal(h.host.sendPublic(healthy, healthyBytes), true);
    await h.scheduler.flushReady();
    const [delivery] = h.broker.drainClient("client-unbind-pending-healthy", { maxFrames: 1 });
    assert.ok(delivery);
    assert.deepEqual(Buffer.from(delivery.bytes), Buffer.from(healthyBytes));
    acceptClientDelivery(h, delivery);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().phase, "running");
  });

  await t.test("in-flight Broker receive settles before route.unbind handoff", async () => {
    const h = createHarness();
    await startRegistered(h);
    const closing = await openRoute(h, "client-unbind-inflight");
    const healthy = await openRoute(h, "client-unbind-inflight-healthy");
    const receiveHostFrame = h.broker.receiveHostFrame.bind(h.broker);
    let releaseReceive;
    h.broker.receiveHostFrame = async (transportId, bytes, signal) => {
      const result = await receiveHostFrame(transportId, bytes, signal);
      const frame = decodedCarrier(bytes);
      if (frame.type !== "route.data" || frame.routeId !== closing.routeId) return result;
      return new Promise((resolve) => { releaseReceive = () => resolve(result); });
    };

    const inFlight = publicHostFrame("inflight-before-client-close");
    assert.equal(h.host.sendPublic(closing, inFlight), true);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().inFlightHostDelivery, true);
    assert.equal(typeof releaseReceive, "function");
    h.pump.acceptBrokerResult(h.broker.unbindClient(
      "client-unbind-inflight",
      "client_closed",
    ));
    await h.scheduler.flushReady();

    assert.equal(h.unbound.some((entry) => (
      entry.binding.connectionId === "client-unbind-inflight"
    )), false);
    assert.equal(h.pump.snapshot().phase, "running");
    assert.equal(h.scheduler.tasks.some((task) => (
      !task.cancelled && task.at <= h.scheduler.now
    )), false, "the unbind uncertainty barrier must not schedule a 0ms spin");

    releaseReceive();
    await h.scheduler.flushReady();
    assert.equal(h.unbound.some((entry) => (
      entry.binding.connectionId === "client-unbind-inflight"
        && entry.reason === "client_closed"
    )), true);
    assert.equal(h.pump.snapshot().phase, "running");
    assert.equal(
      h.broker.drainClient("client-unbind-inflight", { maxFrames: 1 }).length,
      0,
      "Broker may discard already-accepted reverse data after the client closes",
    );

    const healthyBytes = publicHostFrame("healthy-after-inflight-unbind");
    assert.equal(h.host.sendPublic(healthy, healthyBytes), true);
    await h.scheduler.flushReady();
    const [healthyDelivery] = h.broker.drainClient(
      "client-unbind-inflight-healthy",
      { maxFrames: 1 },
    );
    assert.ok(healthyDelivery);
    assert.deepEqual(Buffer.from(healthyDelivery.bytes), Buffer.from(healthyBytes));
    acceptClientDelivery(h, healthyDelivery);
    await h.scheduler.flushReady();
    assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  });
});

test("five-second owner sweep closes only the pressured route and preserves a healthy route", async () => {
  const h = createHarness();
  await startRegistered(h);
  const route = await openRoute(h, "client-pressure-timeout");
  const healthy = await openRoute(h, "client-pressure-healthy");

  for (let index = 1; index <= brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    assert.equal(h.host.sendPublic(route, publicHostFrame(`timeout-${index}`)), true);
    await h.scheduler.flushReady();
  }
  assert.equal(h.host.sendPublic(route, publicHostFrame("timeout-retained")), true);
  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [route.routeId]);
  assert.equal(h.pump.snapshot().hostToBroker.frames, 0);
  // A stale writable edge makes the Host retry once. BrokerCore rejects that
  // exact seq, so the pump now owns an explicit unaccepted delivery which the
  // later route.unbind fence must release without ACKing it.
  h.pump.acceptBrokerResult({
    accepted: true,
    actions: [{
      kind: "resume_host_route",
      transportId: h.transportId,
      routeId: route.routeId,
    }],
  });
  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, [route.routeId]);
  assert.equal(h.pump.snapshot().hostToBroker.frames, 1);

  await h.scheduler.advance(5_000);
  assert.equal(h.brokerActions.some((action) => (
    action.kind === "close_client"
    && action.connectionId === "client-pressure-timeout"
    && action.closeCode === 1013
  )), true);
  assert.equal(h.pump.snapshot().phase, "running");
  assert.deepEqual(h.pump.snapshot().blockedHostRoutes, []);
  const healthyBytes = publicHostFrame("healthy-after-pressure-close");
  assert.equal(h.host.sendPublic(healthy, healthyBytes), true);
  await h.scheduler.flushReady();
  const [healthyDelivery] = h.broker.drainClient("client-pressure-healthy", { maxFrames: 1 });
  assert.ok(healthyDelivery);
  assert.deepEqual(Buffer.from(healthyDelivery.bytes), Buffer.from(healthyBytes));
  acceptClientDelivery(h, healthyDelivery);
  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  assert.equal(h.scheduler.liveDelayedTasks().length, 0);
});

test("terminal client cleanup clears paused pressure without a resume edge", async () => {
  const h = createHarness();
  await startRegistered(h);
  await openRoute(h, "client-paused-terminal");
  await openRoute(h, "client-paused-healthy");
  h.pump.setWritable("broker_to_host", false);

  let highWater;
  for (let index = 0; index < brokerModule.RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames; index += 1) {
    highWater = h.broker.forwardClientFrame(
      "client-paused-terminal",
      publicClientFrame(`paused-terminal-${index}`),
    );
    assert.equal(highWater.accepted, true);
    h.pump.acceptBrokerResult(highWater);
    await h.scheduler.flushReady();
  }
  assert.equal(highWater.actions.some((action) => action.kind === "pause_client"), true);
  assert.deepEqual(h.pump.snapshot().pausedClients, ["client-paused-terminal"]);

  await h.scheduler.advance(5_000);
  assert.equal(h.brokerActions.some((action) => (
    action.kind === "close_client"
      && action.connectionId === "client-paused-terminal"
  )), true);
  assert.equal(h.brokerActions.some((action) => (
    action.kind === "resume_client"
      && action.connectionId === "client-paused-terminal"
  )), false);
  assert.deepEqual(h.pump.snapshot().pausedClients, []);
  assert.equal(h.pump.snapshot().phase, "running");

  await h.scheduler.advance(5_001);
  assert.equal(h.pump.snapshot().phase, "running");
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  h.pump.setWritable("broker_to_host", true);
  await h.scheduler.flushReady();
  const healthyBytes = publicClientFrame("healthy-after-paused-terminal");
  const healthy = h.broker.forwardClientFrame("client-paused-healthy", healthyBytes);
  assert.equal(healthy.accepted, true);
  h.pump.acceptBrokerResult(healthy);
  await h.scheduler.flushReady();
  assert.deepEqual(h.received.at(-1).payload, healthyBytes);
  assert.equal(h.pump.snapshot().phase, "running");
});

test("pump queues are byte/frame bounded with control reserve and shutdown cancels pressure timers", async () => {
  const h = createHarness({
    queueLimits: {
      maxBytesPerDirection: 8_192,
      lowWaterBytesPerDirection: 2_048,
      maxFramesPerDirection: 16,
      lowWaterFramesPerDirection: 4,
      controlReserveBytesPerDirection: 2_048,
      controlReserveFramesPerDirection: 4,
      maxBytesPerRoute: 6_144,
      maxFramesPerRoute: 12,
      maxPendingActions: 16,
      maxPendingActionBytes: 8_192,
    },
  });
  await startRegistered(h);
  const binding = await openRoute(h, "client-bounded");

  // Do not run the manual scheduler while the producer fills the transport;
  // accepted data must stop at the pump's per-route/data ceilings.
  for (let index = 0; index < 32; index += 1) {
    h.host.sendPublic(binding, publicHostFrame(`bounded-${index}`));
  }
  const held = h.pump.snapshot().hostToBroker;
  assert.ok(held.frames > 0);
  assert.ok(held.frames <= 12);
  assert.ok(held.bytes <= 6_144);
  assert.ok(held.frames <= 16 - 4, "data leaves a frame reserve for control");
  assert.ok(held.bytes <= 8_192 - 2_048, "data leaves a byte reserve for control");

  assert.equal(h.host.closeRoute(binding, "host_shutdown"), true);
  const withControl = h.pump.snapshot().hostToBroker;
  assert.ok(withControl.frames > held.frames, "route control uses the reserved capacity");
  assert.ok(withControl.frames <= 16);
  assert.ok(withControl.bytes <= 8_192);

  await h.scheduler.flushReady();
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  assert.equal(
    h.scheduler.liveDelayedTasks().length,
    0,
    "crossing adapter low water cancels its pressure timer",
  );

  const brokerRoute = await openRoute(h, "client-bounded-broker-direction");
  h.pump.setWritable("broker_to_host", false);
  const receivedBeforeReserve = h.received.length;
  for (let index = 0; index < 12; index += 1) {
    const forwarded = h.broker.forwardClientFrame(
      "client-bounded-broker-direction",
      publicClientFrame(`bounded-broker-${index}`),
    );
    assert.equal(forwarded.accepted, true);
    h.pump.acceptBrokerResult(forwarded);
    await h.scheduler.flushReady();
  }
  assert.equal(h.pump.snapshot().brokerToHost.frames, 12);
  const brokerUnbind = h.broker.unbindClient(
    "client-bounded-broker-direction",
    "client_closed",
  );
  assert.equal(brokerUnbind.accepted, true);
  h.pump.acceptBrokerResult(brokerUnbind);
  await h.scheduler.flushReady();
  assert.equal(
    h.pump.snapshot().brokerToHost.frames,
    13,
    "Broker control uses the reserved frame after data reaches its ceiling",
  );
  assert.ok(h.pump.snapshot().brokerToHost.bytes <= 8_192);
  h.pump.setWritable("broker_to_host", true);
  await h.scheduler.flushReady();
  assert.equal(h.received.length - receivedBeforeReserve, 12);
  assert.equal(h.unbound.some((entry) => (
    entry.binding.routeId === brokerRoute.routeId && entry.reason === "client_closed"
  )), true);
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });

  h.pump.shutdown(1013, "bounded-test-shutdown");
  await h.scheduler.flushReady();
  assert.equal(h.pump.snapshot().phase, "closed");
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  assert.equal(h.pump.snapshot().pendingActions, 0);
  assert.equal(h.pump.snapshot().pendingActionBytes, 0);
  assert.equal(h.scheduler.liveDelayedTasks().length, 0);
});

test("mandatory teardown reserve survives a full ordinary action queue and 128-route disconnect", async () => {
  const owner = new StatefulBrokerActionOwner();
  let h;
  h = createHarness({
    queueLimits: {
      maxPendingActions: 128,
      maxPendingActionBytes: 1_048_576,
    },
    actionSink(action, _signal, fence) {
      if (action.kind === "route_opened") return new Promise(() => {});
      return owner.apply(action, fence);
    },
    forceActionSink(action, fence) {
      return owner.force(action, fence);
    },
  });
  await startRegistered(h);
  const connectionIds = [];
  for (let index = 0; index < 128; index += 1) {
    const connectionId = `client-mandatory-burst-${index.toString().padStart(3, "0")}`;
    connectionIds.push(connectionId);
    owner.trackClient(connectionId);
    const opened = h.broker.openClientRoute(
      connectionId,
      authContext("client", h.scheduler.now),
    );
    assert.equal(opened.accepted, true);
    h.pump.acceptBrokerResult(opened);
    await h.scheduler.flushReady();
    assert.ok(h.bound.some((binding) => binding.connectionId === connectionId));
  }
  assert.equal(h.pump.snapshot().pendingActions, 128);
  assert.equal(h.pump.snapshot().mandatoryActions, 0);

  const closeBarrier = h.pump.whenCloseSettled();
  h.pump.acceptBrokerResult({
    accepted: false,
    actions: [{
      kind: "close_host",
      transportId: h.transportId,
      closeCode: 1013,
      reason: "mandatory-burst-close",
    }],
  });
  await h.scheduler.flushReady();

  assert.equal(h.pump.snapshot().phase, "closing");
  assert.equal(h.pump.snapshot().mandatoryActions, 1);
  assert.equal(h.brokerActions.filter((action) => action.kind === "close_client").length, 127);
  assert.equal(h.brokerActions.some((action) => action.kind === "close_host"), true);
  await h.scheduler.advance(5_000);
  const receipt = await closeBarrier;

  assert.equal(receipt.outcome, "closed");
  assert.equal(h.pump.snapshot().phase, "closed");
  assert.equal(h.pump.snapshot().mandatoryActions, 0);
  assert.equal(h.forcedBrokerActions.filter((action) => action.kind === "close_client").length, 1);
  assert.equal(
    h.brokerActions.filter((action) => action.kind === "close_client").length
      + h.forcedBrokerActions.filter((action) => action.kind === "close_client").length,
    128,
  );
  assert.equal(connectionIds.every((connectionId) => !owner.isOpen(connectionId)), true);
  assert.equal(h.pump.snapshot().terminalFailure, null);
});

test("mandatory capacity overflow beyond 128 routes stops after one registered force failure", async () => {
  let directoryAtForce = "not-called";
  let registeredAtForce = 0;
  let routeAcceptedAtForce = true;
  let forceCalls = 0;
  let h;
  h = createHarness({
    hostQueueLimits: {
      maxRoutes: 256,
    },
    queueLimits: {
      maxPendingActions: 8,
      maxPendingActionBytes: 1_048_576,
    },
    forceActionSink() {
      forceCalls += 1;
      directoryAtForce = h.broker.inspectHost(HOST_ID);
      registeredAtForce = h.pump.snapshot().mandatoryActions;
      routeAcceptedAtForce = h.broker.forwardClientFrame(
        "client-unbounded-opening-159",
        publicClientFrame("must-already-be-offline"),
      ).accepted;
      return false;
    },
  });
  await startRegistered(h);
  for (let index = 0; index < 160; index += 1) {
    await openRoute(h, `client-unbounded-opening-${index.toString().padStart(3, "0")}`);
  }
  assert.equal(h.pump.snapshot().pendingActions, 0, "normal route-open actions are consumed");
  assert.equal(
    h.brokerActions.filter((action) => action.kind === "route_opened").length,
    160,
  );

  const closeBarrier = h.pump.shutdown(1013, "mandatory-capacity-overflow");
  const receipt = await closeBarrier;
  const stableSnapshot = h.pump.snapshot();

  assert.equal(directoryAtForce?.state, "offline", "Broker directory is offline before force handoff");
  assert.equal(routeAcceptedAtForce, false, "active routes are gone before force handoff");
  assert.equal(registeredAtForce, 131, "the emergency entry is capacity + one before callback");
  assert.equal(forceCalls, 1);
  assert.equal(receipt.outcome, "terminal_failure");
  assert.equal(receipt.failedMandatoryActions, 1);
  assert.equal(stableSnapshot.phase, "terminal_failure");
  assert.equal(stableSnapshot.scheduledTimers, 0);
  assert.equal(stableSnapshot.mandatoryActions, 131, "registry is hard bounded at capacity plus one");
  assert.equal(h.broker.inspectHost(HOST_ID)?.state, "offline");
  assert.equal(h.scheduler.liveDelayedTasks().length, 0);

  h.pump.acceptBrokerResult({
    accepted: true,
    actions: [
      {
        kind: "close_client",
        connectionId: "late-current-batch-after-terminal-failure",
        closeCode: 1013,
        reason: "must-not-append",
      },
      {
        kind: "route_unavailable",
        connectionId: "late-next-batch-after-terminal-failure",
        hostId: HOST_ID,
        closeCode: 1013,
        error: {
          code: "HOST_OFFLINE",
          message: "must-not-append",
          retryable: true,
          retryAfterMs: null,
          commandDisposition: "not_applicable",
          details: null,
        },
      },
    ],
  });
  assert.equal(forceCalls, 1);
  assert.equal(h.pump.snapshot().mandatoryActions, stableSnapshot.mandatoryActions);
  assert.equal(h.pump.snapshot().mandatoryActionBytes, stableSnapshot.mandatoryActionBytes);
  assert.equal(await h.pump.shutdown(), receipt);
});

test("closing admission includes a late production route_unavailable before receipt", async () => {
  const effects = [];
  let h;
  h = createHarness({
    actionSink(action, signal) {
      if (action.kind !== "route_unavailable") return undefined;
      return settleActionAfter(h.scheduler, signal, 100, () => {
        effects.push(`route_unavailable:${action.connectionId}`);
      });
    },
  });
  await startRegistered(h);

  const closeBarrier = h.pump.shutdown();
  assert.equal(h.pump.snapshot().phase, "closing");
  const lateUnavailable = h.broker.openClientRoute(
    "client-late-closing-admission",
    authContext("client", h.scheduler.now),
  );
  assert.equal(lateUnavailable.accepted, false);
  assert.equal(lateUnavailable.actions[0].kind, "route_unavailable");
  h.pump.acceptBrokerResult(lateUnavailable);
  await h.scheduler.flushReady();

  assert.equal(h.pump.snapshot().phase, "closing");
  assert.deepEqual(effects, []);
  await h.scheduler.advance(100);
  assert.deepEqual(effects, ["route_unavailable:client-late-closing-admission"]);
  assert.equal((await closeBarrier).outcome, "closed");
  assert.equal(h.pump.snapshot().phase, "closed");
});

test("hung broker receive/auth and async action sinks are deadline fenced without leaks", async (t) => {
  await t.test("hung receive with another eligible route has no due-now churn and drains every route", async () => {
    const effects = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_client") return undefined;
        return settleActionAfter(h.scheduler, signal, 100, () => {
          effects.push(`close_client:${action.connectionId}`);
        });
      },
    });
    await startRegistered(h);
    const routeA = await openRoute(h, "client-hung-receive-a");
    const routeB = await openRoute(h, "client-hung-receive-b");
    const receiveHostFrame = h.broker.receiveHostFrame.bind(h.broker);
    let routeDataCalls = 0;
    h.broker.receiveHostFrame = (transportId, bytes, signal) => {
      if (decodedCarrier(bytes).type !== "route.data") {
        return receiveHostFrame(transportId, bytes, signal);
      }
      routeDataCalls += 1;
      return routeDataCalls === 1
        ? new Promise(() => {})
        : receiveHostFrame(transportId, bytes, signal);
    };

    const tasksBeforeHungDelivery = h.scheduler.tasks.length;
    assert.equal(h.host.sendPublic(routeA, publicHostFrame("hung-receive-a")), true);
    assert.equal(h.host.sendPublic(routeB, publicHostFrame("eligible-behind-hung")), true);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().inFlightHostDelivery, true);
    assert.equal(h.pump.snapshot().hostToBroker.frames, 2);
    assert.ok(
      h.scheduler.tasks.length - tasksBeforeHungDelivery < 10,
      "an active delivery attempt with eligible work behind it must not spin",
    );
    assert.equal(h.scheduler.tasks.some((task) => (
      !task.cancelled && task.at <= h.scheduler.now
    )), false);

    await h.scheduler.advance(5_000);
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.equal(h.pump.snapshot().closeReason, null);
    assert.deepEqual(effects, []);
    await h.scheduler.advance(100);
    assert.deepEqual(effects, [
      "close_client:client-hung-receive-a",
      "close_client:client-hung-receive-b",
    ]);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "host_delivery_timeout");
    assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
    assert.equal(h.scheduler.liveDelayedTasks().length, 0);
  });

  await t.test("never-resolving auth authority is aborted by the same deadline", async () => {
    const h = createHarness({
      brokerOptions: {
        authControlAuthority: { handle: () => new Promise(() => {}) },
      },
    });
    await startRegistered(h);
    assert.equal(h.host.requestReauthentication("hung-auth", "host-credential"), true);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().inFlightHostDelivery, true);

    await h.scheduler.advance(5_000);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "host_delivery_timeout");
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
    assert.equal(h.scheduler.liveDelayedTasks().length, 0);
  });

  await t.test("hung action with another queued action has no due-now churn or late reopen", async () => {
    const owner = new StatefulBrokerActionOwner();
    let sinkSignal;
    let h;
    h = createHarness({
      actionSink(action, signal, fence) {
        if (action.kind === "route_opened") {
          sinkSignal = signal;
          return new Promise((resolve) => {
            h.scheduler.schedule(11_000, () => {
              owner.apply(action, fence);
              resolve();
            });
          });
        }
        if (action.kind === "close_client") {
          return settleActionAfter(h.scheduler, signal, 100, () => {
            owner.apply(action, fence);
          });
        }
        return undefined;
      },
      forceActionSink(action, fence) {
        return owner.force(action, fence);
      },
    });
    await startRegistered(h);
    owner.trackClient("client-hung-action");
    await openRoute(h, "client-hung-action");
    assert.equal(h.pump.snapshot().inFlightBrokerAction, true);
    const tasksBeforeSecondAction = h.scheduler.tasks.length;
    h.pump.acceptBrokerResult({
      accepted: true,
      actions: [{
        kind: "close_client",
        connectionId: "queued-before-disconnect",
        closeCode: 1013,
        reason: "queued_cleanup",
      }],
    });
    await h.scheduler.flushReady();
    assert.ok(h.scheduler.tasks.length - tasksBeforeSecondAction < 10);
    assert.equal(h.scheduler.tasks.some((task) => (
      !task.cancelled && task.at <= h.scheduler.now
    )), false);

    await h.scheduler.advance(5_000);
    assert.equal(sinkSignal.aborted, true);
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.deepEqual(owner.effects, []);
    assert.equal(h.brokerActions.some((action) => (
      action.kind === "close_client"
        && action.connectionId === "queued-before-disconnect"
    )), true);
    assert.equal(h.brokerActions.some((action) => (
      action.kind === "close_client"
        && action.connectionId === "client-hung-action"
    )), false);
    await h.scheduler.advance(100);
    assert.deepEqual(owner.effects, ["close_client:queued-before-disconnect"]);
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.equal(h.brokerActions.some((action) => (
      action.kind === "close_client"
        && action.connectionId === "client-hung-action"
    )), false);
    await h.scheduler.advance(4_900);
    assert.deepEqual(owner.effects, [
      "close_client:queued-before-disconnect",
      "close_client:client-hung-action",
    ]);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "broker_action_timeout");
    assert.equal(h.pump.snapshot().pendingActions, 0);
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
    assert.equal(owner.isOpen("client-hung-action"), false);
    assert.equal(owner.forceCalls.length, 1);
    await h.scheduler.advance(1_000);
    assert.equal(owner.isOpen("client-hung-action"), false);
    assert.deepEqual(owner.rejectedEffects, ["route_opened:client-hung-action"]);
    assert.equal(
      owner.effects.includes("route_opened:client-hung-action"),
      false,
      "the socket owner fence rejects an abort-ignoring effect after final cleanup",
    );
  });
});

test("final close drains client side effects from shutdown, host failure, and protocol failure", async (t) => {
  await t.test("shutdown waits for the open route close effect", async () => {
    const effects = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_client") return undefined;
        return settleActionAfter(h.scheduler, signal, 100, () => effects.push(action));
      },
    });
    await startRegistered(h);
    await openRoute(h, "client-shutdown-drain");

    h.pump.shutdown(1000, "shutdown-drain-test");
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.deepEqual(effects, []);
    await h.scheduler.advance(100);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(effects.some((action) => (
      action.kind === "close_client"
      && action.connectionId === "client-shutdown-drain"
      && action.reason === "host_offline"
    )), true);
  });

  await t.test("host receive rejection waits for its open client close effect", async () => {
    const effects = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_client") return undefined;
        return settleActionAfter(h.scheduler, signal, 100, () => effects.push(action));
      },
    });
    await startRegistered(h);
    const route = await openRoute(h, "client-host-failure-drain");
    const receiveHostFrame = h.broker.receiveHostFrame.bind(h.broker);
    h.broker.receiveHostFrame = (transportId, bytes, signal) => (
      decodedCarrier(bytes).type === "route.data"
        ? Promise.reject(new Error("host receive failed"))
        : receiveHostFrame(transportId, bytes, signal)
    );

    assert.equal(h.host.sendPublic(route, publicHostFrame("host-failure-drain")), true);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.deepEqual(effects, []);
    await h.scheduler.advance(100);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "host_delivery_failure");
    assert.equal(effects.some((action) => (
      action.kind === "close_client" && action.connectionId === "client-host-failure-drain"
    )), true);
  });

  await t.test("same-frame protocol close completes both host and client effects before final close", async () => {
    const effects = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_host" && action.kind !== "close_client") return undefined;
        return settleActionAfter(h.scheduler, signal, 100, () => {
          effects.push(`${action.kind}:${action.kind === "close_host"
            ? action.transportId
            : action.connectionId}`);
        });
      },
    });
    await startRegistered(h);
    const route = await openRoute(h, "client-protocol-drain");
    const invalid = carrierFrame({
      carrierVersion: 1,
      type: "route.data",
      connectorId: route.connectorId,
      routeId: route.routeId,
      routeFence: "stale-route-fence",
      direction: "host_to_client",
      seq: "1",
      payload: {
        opcode: "text",
        encoding: "base64",
        data: Buffer.from(publicHostFrame("protocol-drain")).toString("base64"),
      },
    });

    assert.equal(h.pump.trySend(invalid, "protocol-drain-token"), true);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.deepEqual(effects, []);
    await h.scheduler.advance(100);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeCode, 4400);
    assert.deepEqual(effects, [
      `close_host:${h.transportId}`,
      "close_client:client-protocol-drain",
    ]);
  });

  await t.test("one rejected cleanup does not swallow later disconnect cleanup", async () => {
    const effects = [];
    const forced = [];
    let teardown = false;
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (!teardown || action.kind !== "close_client") return undefined;
        const reject = action.connectionId === "client-rejected-cleanup";
        return settleActionAfter(h.scheduler, signal, 100, () => {
          effects.push(`close_client:${action.connectionId}`);
        }, reject);
      },
      forceActionSink(action) {
        forced.push(`${action.kind}:${action.connectionId ?? action.transportId}`);
        return true;
      },
    });
    await startRegistered(h);
    await openRoute(h, "client-rejected-cleanup");
    await openRoute(h, "client-following-cleanup");
    teardown = true;

    h.pump.shutdown();
    assert.equal(h.pump.snapshot().phase, "closing");
    await h.scheduler.advance(100);
    assert.equal(h.pump.snapshot().closeActionFailures, 1);
    assert.deepEqual(effects, ["close_client:client-following-cleanup"]);
    assert.deepEqual(forced, ["close_client:client-rejected-cleanup"]);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeActionFailures, 1);
  });

  await t.test("pump failure waits for disconnect cleanup", async () => {
    const effects = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_client") return undefined;
        return settleActionAfter(h.scheduler, signal, 100, () => effects.push(action));
      },
    });
    await startRegistered(h);
    await openRoute(h, "client-pump-failure");
    h.broker.drainHostCarrier = () => { throw new Error("pump failure"); };

    h.pump.writable("broker_to_host");
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.deepEqual(effects, []);
    await h.scheduler.advance(100);

    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "carrier_pump_failure");
    assert.equal(effects.some((action) => (
      action.kind === "close_client" && action.connectionId === "client-pump-failure"
    )), true);
  });

  await t.test("one hung route close cannot prevent another route cleanup handoff", async () => {
    let hungSignal;
    const effects = [];
    const forced = [];
    let h;
    h = createHarness({
      actionSink(action, signal) {
        if (action.kind !== "close_client") return undefined;
        if (action.connectionId === "client-hung-close-first") {
          hungSignal = signal;
          return new Promise(() => {});
        }
        return settleActionAfter(h.scheduler, signal, 100, () => {
          effects.push(`close_client:${action.connectionId}`);
        });
      },
      forceActionSink(action) {
        forced.push(`${action.kind}:${action.connectionId ?? action.transportId}`);
        return true;
      },
    });
    await startRegistered(h);
    await openRoute(h, "client-hung-close-first");
    await openRoute(h, "client-hung-close-second");

    h.pump.shutdown();
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.equal(h.pump.snapshot().inFlightCloseActions, 2);
    assert.equal(h.brokerActions.filter((action) => action.kind === "close_client").length, 2);
    await h.scheduler.advance(100);
    assert.deepEqual(effects, ["close_client:client-hung-close-second"]);
    assert.deepEqual(forced, []);
    assert.equal(h.pump.snapshot().phase, "closing");
    assert.equal(h.pump.snapshot().inFlightCloseActions, 1);
    await h.scheduler.advance(4_900);

    assert.equal(hungSignal.aborted, true);
    assert.deepEqual(forced, ["close_client:client-hung-close-first"]);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().inFlightCloseActions, 0);
    assert.equal(h.pump.snapshot().pendingActions, 0);
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
    assert.equal(h.scheduler.liveDelayedTasks().length, 0);
  });

  for (const forceFailure of ["throw", "nontrue"]) {
    await t.test(`force ${forceFailure} yields an observable terminal failure receipt`, async () => {
      const owner = new StatefulBrokerActionOwner();
      let teardown = false;
      let forceCalls = 0;
      const h = createHarness({
        actionSink(action, _signal, fence) {
          if (action.kind === "route_opened") return owner.apply(action, fence);
          if (teardown && action.kind === "close_client") return new Promise(() => {});
          return undefined;
        },
        forceActionSink() {
          forceCalls += 1;
          if (forceFailure === "throw") throw new Error("force owner failed");
          return false;
        },
      });
      await startRegistered(h);
      owner.trackClient(`client-force-${forceFailure}`);
      await openRoute(h, `client-force-${forceFailure}`);
      teardown = true;

      const closeBarrier = h.pump.shutdown();
      assert.equal(h.pump.whenCloseSettled(), closeBarrier);
      await h.scheduler.advance(5_000);
      const receipt = await closeBarrier;

      assert.deepEqual(receipt, {
        outcome: "terminal_failure",
        code: 1000,
        reason: "mandatory_force_rejected",
        failedMandatoryActions: 1,
      });
      assert.equal(h.pump.snapshot().phase, "terminal_failure");
      assert.equal(h.pump.snapshot().terminalFailure, "mandatory_force_rejected");
      assert.equal(h.pump.snapshot().mandatoryActions, 1);
      assert.ok(h.pump.snapshot().mandatoryActionBytes > 0);
      assert.equal(h.pump.snapshot().closeCode, null);
      assert.equal(owner.isOpen(`client-force-${forceFailure}`), true);
      assert.equal(forceCalls, 1, "a failed force receipt is not retried or deduped away");
      assert.equal(await h.pump.shutdown(), receipt);
    });
  }

  await t.test("force is reentry-safe and dedupes retired and disconnect cleanup", async () => {
    const owner = new StatefulBrokerActionOwner();
    let reentrantBarrier;
    let h;
    h = createHarness({
      actionSink(action, _signal, fence) {
        if (action.kind === "route_opened") return owner.apply(action, fence);
        if (action.kind === "close_client") return new Promise(() => {});
        return undefined;
      },
      forceActionSink(action, fence) {
        reentrantBarrier = h.pump.shutdown(1000, "force_reentry");
        return owner.force(action, fence);
      },
    });
    await startRegistered(h);
    owner.trackClient("client-force-reentry");
    await openRoute(h, "client-force-reentry");
    h.pump.acceptBrokerResult({
      accepted: true,
      actions: [{
        kind: "close_client",
        connectionId: "client-force-reentry",
        closeCode: 1013,
        reason: "queued-before-shutdown",
      }],
    });
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().inFlightBrokerAction, true);

    const closeBarrier = h.pump.shutdown();
    await h.scheduler.advance(5_000);
    const receipt = await closeBarrier;

    assert.equal(reentrantBarrier, closeBarrier);
    assert.equal(receipt.outcome, "closed");
    assert.equal(owner.isOpen("client-force-reentry"), false);
    assert.equal(owner.forceCalls.length, 1);
    assert.equal(h.forcedBrokerActions.filter((action) => (
      action.kind === "close_client"
        && action.connectionId === "client-force-reentry"
    )).length, 1);
    assert.equal(h.brokerActions.filter((action) => (
      action.kind === "close_client"
        && action.connectionId === "client-force-reentry"
    )).length, 1, "disconnectHost cleanup is deduped against the retired handoff");
  });
});

test("shutdown gets a fresh close deadline and ignores an uncancellable receive settlement", async (t) => {
  for (const settlement of ["resolve", "reject"]) {
    await t.test(`late ${settlement}`, async () => {
      const effects = [];
      let closeSignal;
      let h;
      h = createHarness({
        actionSink(action, signal) {
          if (action.kind !== "close_client") return undefined;
          closeSignal = signal;
          return settleActionAfter(h.scheduler, signal, 2_000, () => {
            effects.push(`close_client:${action.connectionId}`);
          });
        },
      });
      await startRegistered(h);
      const route = await openRoute(h, `client-late-${settlement}`);
      const receiveHostFrame = h.broker.receiveHostFrame.bind(h.broker);
      let resolveHung;
      let rejectHung;
      h.broker.receiveHostFrame = (transportId, bytes, signal) => {
        if (decodedCarrier(bytes).type !== "route.data") {
          return receiveHostFrame(transportId, bytes, signal);
        }
        return new Promise((resolve, reject) => {
          resolveHung = resolve;
          rejectHung = reject;
        });
      };
      assert.equal(h.host.sendPublic(route, publicHostFrame(`late-${settlement}`)), true);
      await h.scheduler.flushReady();
      assert.equal(h.pump.snapshot().inFlightHostDelivery, true);
      await h.scheduler.advance(4_000);

      h.pump.shutdown(1013, "preempt-hung-receive");
      assert.equal(h.pump.snapshot().phase, "closing");
      assert.equal(h.pump.snapshot().inFlightHostDelivery, false);
      assert.equal(closeSignal.aborted, false);
      await h.scheduler.advance(1_000);
      assert.equal(h.pump.snapshot().phase, "closing", "the old host deadline is cancelled");
      assert.equal(closeSignal.aborted, false);
      assert.deepEqual(effects, []);
      await h.scheduler.advance(1_000);
      assert.equal(h.pump.snapshot().phase, "closed");
      assert.deepEqual(effects, [`close_client:client-late-${settlement}`]);
      const actionsAfterClose = h.brokerActions.length;
      if (settlement === "resolve") {
        resolveHung({
          accepted: true,
          actions: [{
            kind: "resume_host_route",
            transportId: h.transportId,
            routeId: route.routeId,
          }],
        });
      } else {
        rejectHung(new Error("late receive failure"));
      }
      await new Promise((resolve) => setImmediate(resolve));
      await h.scheduler.flushReady();

      assert.equal(h.pump.snapshot().phase, "closed");
      assert.equal(h.brokerActions.length, actionsAfterClose);
      assert.deepEqual(h.pump.snapshot().blockedHostRoutes, []);
      assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
      assert.equal(h.pump.snapshot().scheduledTimers, 0);
      assert.equal(h.scheduler.liveDelayedTasks().length, 0);
    });
  }
});

test("terminal broker controls drain before duplicate, identity, and supersede closes", async (t) => {
  await t.test("duplicate connector carrier.error precedes 4411 close", async () => {
    const hostInstanceId = randomUUID();
    const first = createHarness({ hostInstanceId, transportId: "duplicate-first" });
    await startRegistered(first);
    let duplicate;
    duplicate = createHarness({
      broker: first.broker,
      hostInstanceId,
      transportId: "duplicate-second",
      actionSink(action, signal) {
        if (action.kind !== "close_host") return undefined;
        return settleActionAfter(duplicate.scheduler, signal, 10, () => {
          duplicate.eventLog.push(`effect:close_host:${action.closeCode}`);
        });
      },
    });
    observeCarrierReceives(duplicate);
    duplicate.pump.start();
    await duplicate.scheduler.flushReady();

    assert.ok(duplicate.eventLog.indexOf("receive:carrier.error") >= 0);
    assert.equal(duplicate.eventLog.includes("effect:close_host:4411"), false);
    assert.equal(duplicate.pump.snapshot().phase, "closing");
    await duplicate.scheduler.advance(10);
    assert.ok(
      duplicate.eventLog.indexOf("receive:carrier.error")
        < duplicate.eventLog.indexOf("effect:close_host:4411"),
    );
    assert.equal(duplicate.pump.snapshot().closeCode, 4411);
    assert.equal(duplicate.pump.snapshot().phase, "closed");
  });

  await t.test("a blocked terminal control still force-closes the duplicate at the drain deadline", async () => {
    const hostInstanceId = randomUUID();
    const first = createHarness({ hostInstanceId, transportId: "terminal-hung-first" });
    await startRegistered(first);
    let duplicate;
    duplicate = createHarness({
      broker: first.broker,
      hostInstanceId,
      transportId: "terminal-hung-second",
      forceActionSink(action) {
        duplicate.eventLog.push(`force:${action.kind}:${action.closeCode ?? "none"}`);
        return true;
      },
    });
    observeCarrierReceives(duplicate);
    duplicate.pump.setWritable("broker_to_host", false);
    duplicate.pump.start();
    await duplicate.scheduler.flushReady();

    assert.equal(duplicate.pump.snapshot().phase, "closing");
    assert.equal(duplicate.eventLog.includes("receive:carrier.error"), false);
    assert.equal(duplicate.brokerActions.some((action) => action.kind === "close_host"), false);
    await duplicate.scheduler.advance(5_000);

    assert.equal(duplicate.pump.snapshot().phase, "closed");
    assert.equal(duplicate.pump.snapshot().closeCode, 4411);
    assert.equal(duplicate.eventLog.includes("force:close_host:4411"), true);
    assert.equal(duplicate.forcedBrokerActions.some((action) => (
      action.kind === "close_host" && action.closeCode === 4411
    )), true);
  });

  await t.test("identity carrier.error precedes broker-selected 4403 close", async () => {
    let h;
    h = createHarness({
      hostId: "different-host-id",
      actionSink(action, signal) {
        if (action.kind !== "close_host") return undefined;
        return settleActionAfter(h.scheduler, signal, 10, () => {
          h.eventLog.push(`effect:close_host:${action.closeCode}`);
        });
      },
    });
    observeCarrierReceives(h);
    h.pump.start();
    await h.scheduler.flushReady();

    assert.ok(h.eventLog.indexOf("receive:carrier.error") >= 0);
    assert.equal(h.eventLog.includes("effect:close_host:4403"), false);
    assert.equal(h.pump.snapshot().phase, "closing");
    await h.scheduler.advance(10);
    assert.ok(
      h.eventLog.indexOf("receive:carrier.error")
        < h.eventLog.indexOf("effect:close_host:4403"),
    );
    assert.equal(h.pump.snapshot().closeCode, 4403);
    assert.equal(h.pump.snapshot().phase, "closed");
  });

  await t.test("host.superseded reaches the old production actor before 4409 close", async () => {
    let first;
    first = createHarness({
      transportId: "superseded-old",
      actionSink(action, signal) {
        if (action.kind !== "close_host") return undefined;
        return settleActionAfter(first.scheduler, signal, 10, () => {
          first.eventLog.push(`effect:close_host:${action.closeCode}`);
        });
      },
    });
    observeCarrierReceives(first);
    await startRegistered(first);
    const replacement = createHarness({
      broker: first.broker,
      transportId: "superseded-new",
      actionSink(action) {
        if (action.transportId === first.transportId) {
          first.pump.acceptBrokerResult({ accepted: true, actions: [action] });
        }
      },
    });
    await startRegistered(replacement);
    await first.scheduler.flushReady();

    assert.ok(first.eventLog.indexOf("receive:host.superseded") >= 0);
    assert.equal(first.eventLog.includes("effect:close_host:4409"), false);
    assert.equal(first.pump.snapshot().phase, "closing");
    await first.scheduler.advance(10);
    assert.ok(
      first.eventLog.indexOf("receive:host.superseded")
        < first.eventLog.indexOf("effect:close_host:4409"),
    );
    assert.equal(first.pump.snapshot().closeCode, 4409);
    assert.equal(first.host.status().phase, "superseded");
    assert.equal(replacement.host.status().phase, "registered");
  });
});

test("broker delivery ACK rejection fails closed after Host acceptance", async (t) => {
  await t.test("stale registration deliveryId cannot leave Host registered", async () => {
    const h = createHarness();
    const acknowledge = h.broker.acknowledgeHostControlDelivery.bind(h.broker);
    h.broker.acknowledgeHostControlDelivery = (transportId, deliveryId) => (
      acknowledge(transportId, `${deliveryId}-stale`)
    );
    h.pump.start();
    await h.scheduler.flushReady();

    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "registration_delivery_commit_rejected");
    assert.equal(h.host.status().phase, "offline");
    assert.equal(h.broker.inspectHost(HOST_ID), undefined);
    assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  });

  await t.test("ordinary host delivery ACK rejection closes retained broker accounting", async () => {
    const h = createHarness();
    await startRegistered(h);
    await openRoute(h, "client-rejected-delivery-ack");
    const acknowledge = h.broker.acknowledgeHostDelivery.bind(h.broker);
    h.broker.acknowledgeHostDelivery = (transportId, deliveryId) => (
      acknowledge(transportId, `${deliveryId}-stale`)
    );
    const result = h.broker.forwardClientFrame(
      "client-rejected-delivery-ack",
      publicClientFrame("rejected-delivery-ack"),
    );
    assert.equal(result.accepted, true);
    h.pump.acceptBrokerResult(result);
    await h.scheduler.flushReady();

    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.pump.snapshot().closeReason, "broker_delivery_ack_rejected");
    assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
    assert.equal(h.pump.snapshot().scheduledTimers, 0);
  });
});

test("legal near-1MiB public frames cross production Host and Broker up to the 16MiB carrier boundary", async () => {
  const h = createHarness();
  await startRegistered(h);
  const probe = largestSessionsSnapshot("near-limit-probe", h.hostEpoch);
  assert.ok(probe.encoded.byteLength > 1_000_000);
  assert.ok(probe.encoded.byteLength <= 1_048_576);
  assert.doesNotThrow(() => codec.decodeRelayV2WebSocketFrame("public", probe.encoded));
  const dataAdmissions = [];
  const trySend = h.pump.trySend.bind(h.pump);
  h.pump.trySend = (bytes, token) => {
    const frame = decodedCarrier(bytes);
    const admitted = trySend(bytes, token);
    if (frame.type === "route.data") {
      dataAdmissions.push({ admitted, carrierBytes: bytes.byteLength });
    }
    return admitted;
  };

  const routes = [];
  for (let index = 0; index < 16; index += 1) {
    const connectionId = `client-near-limit-${index.toString().padStart(2, "0")}`;
    const route = await openRoute(h, connectionId);
    const requestId = `near-limit-${index.toString().padStart(2, "0")}`;
    const request = sessionsSnapshotRequest(requestId, h.hostEpoch);
    const forwarded = h.broker.forwardClientFrame(connectionId, request);
    assert.equal(forwarded.accepted, true);
    h.pump.acceptBrokerResult(forwarded);
    await h.scheduler.flushReady();
    assert.deepEqual(h.received.at(-1).payload, request);
    routes.push({
      connectionId,
      route,
      response: sessionsSnapshotResponse(requestId, h.hostEpoch, probe.cwdBytes),
    });
  }

  const accepted = [];
  let rejected = null;
  for (const candidate of routes) {
    if (!h.host.sendPublic(candidate.route, candidate.response)) {
      rejected = candidate;
      break;
    }
    accepted.push(candidate);
  }
  assert.ok(accepted.length >= 10, "aggregate test must approach the 16 MiB hard limit");
  assert.ok(rejected, "the next legal route frame must hit aggregate admission");
  assert.equal(dataAdmissions.length, accepted.length);
  assert.equal(dataAdmissions.every((entry) => (
    entry.admitted && entry.carrierBytes > 1_048_576
  )), true, "production Host tokens admit base64 carrier wire larger than the raw 1 MiB route limit");
  const held = h.pump.snapshot().hostToBroker;
  assert.equal(held.frames, accepted.length);
  assert.ok(held.bytes > 14 * 1_048_576);
  assert.ok(held.bytes <= 16 * 1_048_576 - 65_536);
  assert.equal(
    h.host.requestReauthentication("aggregate-control-reserve", "host-credential"),
    true,
    "carrier control remains admissible after the next data frame is rejected",
  );
  assert.equal(h.pump.snapshot().hostToBroker.frames, accepted.length + 1);

  await h.scheduler.flushReady();
  for (const candidate of accepted) {
    const [delivery] = h.broker.drainClient(candidate.connectionId, { maxFrames: 1 });
    assert.ok(delivery);
    assert.deepEqual(Buffer.from(delivery.bytes), Buffer.from(candidate.response));
    acceptClientDelivery(h, delivery);
  }
  await h.scheduler.flushReady();
  assert.equal(h.host.status().phase, "registered");
  assert.equal(h.broker.inspectHost(HOST_ID).state, "online");
  assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
  const closeBarrier = h.pump.shutdown();
  await h.scheduler.flushReady();
  assert.equal((await closeBarrier).outcome, "closed");
  assert.equal(h.pump.snapshot().phase, "closed");
  assert.equal(h.pump.snapshot().scheduledTimers, 0);
});

test("malformed host bytes and a stale broker route fence close only their carrier source", async (t) => {
  await t.test("malformed host source", async () => {
    const h = createHarness();
    await startRegistered(h);
    assert.equal(h.pump.trySend(Uint8Array.from([0xff]), "foreign-delivery-token"), false);
    await h.scheduler.flushReady();
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.broker.inspectHost(HOST_ID).state, "offline");
  });

  await t.test("stale broker fence", async () => {
    const h = createHarness();
    await startRegistered(h);
    const binding = await openRoute(h, "client-stale-fence");
    const stale = {
      carrierVersion: 1,
      type: "route.data",
      connectorId: binding.connectorId,
      routeId: binding.routeId,
      routeFence: "stale-route-fence",
      direction: "client_to_host",
      seq: "1",
      payload: {
        opcode: "text",
        encoding: "base64",
        data: Buffer.from(publicClientFrame("must-not-deliver")).toString("base64"),
      },
    };
    // A socket can deliver stale bytes even though BrokerCore itself would not
    // generate them. The production carrier codec and HostCarrier actor must
    // fence that source without touching a different route/connector.
    assert.doesNotThrow(() => carrierFrame(stale));
    h.pump.acceptBrokerResult({
      accepted: true,
      actions: [{
        kind: "send_host",
        transportId: h.transportId,
        frame: stale,
      }],
    });
    await h.scheduler.flushReady();

    assert.equal(h.received.length, 0);
    assert.equal(h.pump.snapshot().phase, "closed");
    assert.equal(h.host.status().phase, "offline");
    assert.equal(h.broker.inspectHost(HOST_ID).state, "offline");
    assert.deepEqual(h.pump.snapshot().hostToBroker, { frames: 0, bytes: 0 });
    assert.deepEqual(h.pump.snapshot().brokerToHost, { frames: 0, bytes: 0 });
  });
});
