import assert from "node:assert/strict";
import test from "node:test";

const codec = await import("../dist/relay/v2/codec.js");
const carrier = await import("../dist/relay/v2/hostCarrier.js");

function wire(frame) {
  return codec.encodeRelayV2WebSocketFrame("carrier", frame);
}

function decoded(frames) {
  return frames.map((frame) => codec.decodeRelayV2WebSocketFrame("carrier", frame).frame);
}

class FakeTransport {
  accepting = true;
  bufferedBytes = 0;
  attempts = 0;
  pendingDeliveries = [];
  sent = [];
  closes = [];
  onClose = undefined;
  onTrySend = undefined;
  acceptFrame = undefined;

  trySend(frame, deliveryToken) {
    this.attempts += 1;
    if (!this.accepting || this.acceptFrame?.(frame) === false) return false;
    this.sent.push(Uint8Array.from(frame));
    this.bufferedBytes += frame.byteLength;
    this.pendingDeliveries.push({ deliveryToken, byteLength: frame.byteLength });
    this.onTrySend?.(deliveryToken, Uint8Array.from(frame));
    return true;
  }

  bufferedAmount() {
    return this.bufferedBytes;
  }

  confirmNext(expectedByteLength) {
    const delivery = this.pendingDeliveries.shift();
    assert.ok(delivery, "no pending fake delivery");
    if (expectedByteLength !== undefined) {
      assert.equal(delivery.byteLength, expectedByteLength);
    }
    this.bufferedBytes -= delivery.byteLength;
    return delivery.deliveryToken;
  }

  close(code, reason) {
    this.closes.push({ code, reason });
    this.onClose?.(code);
  }
}

class FakeCredentials {
  records = new Map();
  prepareResult = undefined;
  prepareError = undefined;
  onPrepare = undefined;
  prepareCalls = [];
  ackCalls = [];
  ackResult = false;

  add(reference, version, accessJti) {
    this.records.set(reference, {
      reference,
      version,
      grantId: "host-grant-uuid",
      accessJti,
      accessToken: `twcap2.${reference}.payload.mac`,
    });
  }

  read(reference) {
    const record = this.records.get(reference);
    assert.ok(record, `missing fake credential ${reference}`);
    return { ...record };
  }

  prepareReauthentication(input) {
    this.prepareCalls.push({ ...input });
    if (this.prepareError) throw this.prepareError;
    if (this.onPrepare) return this.onPrepare({ ...input });
    return this.prepareResult;
  }

  acknowledgeReauthentication(fence) {
    this.ackCalls.push({ ...fence });
    return this.ackResult;
  }
}

function preparedReauthentication(overrides = {}) {
  const reference = overrides.reference ?? "credential-2";
  return {
    fence: {
      reference,
      version: overrides.version ?? "2",
      requestId: overrides.requestId ?? "reauth-2",
      grantId: overrides.grantId ?? "host-grant-uuid",
      accessJti: overrides.accessJti ?? "access-jti-2",
    },
    accessToken: overrides.accessToken ?? `twcap2.${reference}.payload.mac`,
  };
}

function createHarness(options = {}) {
  const credentials = new FakeCredentials();
  credentials.add("credential-1", "1", "access-jti-1");
  const statuses = [];
  const bound = [];
  const received = [];
  const unbound = [];
  const closing = [];
  let nextId = 1;
  const clientDialects = options.clientDialects ?? ["tw-relay.v2"];
  const actor = new carrier.RelayV2HostCarrierActor({
    hostId: "mac-admin",
    hostEpoch: "authority-uuid",
    hostInstanceId: "host-process-uuid",
    credentialReferences: credentials,
    advertisedCapabilities: [],
    clientDialects,
    dialectAdapters: options.dialectAdapters,
    publicPayloadDecoder: options.publicPayloadDecoder,
    clock: options.clock ?? (() => 1_783_700_100_000),
    schedule: options.schedule,
    idFactory: () => `host-hello-${nextId++}`,
    queueLimits: options.queueLimits,
    routeSink: {
      onRouteBound(binding) {
        bound.push(binding);
        return options.onRouteBound?.(binding);
      },
      onClientFrame(binding, payload) {
        received.push({ binding, payload: Uint8Array.from(payload) });
      },
      onRouteUnbound(binding, reason) {
        unbound.push({ binding, reason });
      },
      onRouteClosing(binding, code) {
        closing.push({ binding, code });
      },
    },
    onStatus: (status) => statuses.push(status),
  });
  return {
    actor,
    credentials,
    statuses,
    bound,
    received,
    unbound,
    closing,
    clientDialects,
  };
}

function connect(harness, transport = new FakeTransport(), credential = "credential-1") {
  const connection = harness.actor.connect(transport, credential);
  const hello = decoded(transport.sent).at(-1);
  assert.equal(hello.type, "host.hello");
  assert.deepEqual(hello.payload.clientDialects, harness.clientDialects);
  assert.deepEqual(hello.payload.capabilities, []);
  return { connection, transport, hello };
}

function acknowledgeAll(connection, transport) {
  while (transport.pendingDeliveries.length > 0) {
    connection.acknowledge(transport.confirmNext());
  }
}

function register(connection, hello, options = {}) {
  const connectorId = options.connectorId ?? "connector-uuid";
  const disposition = options.disposition ?? "connected";
  connection.receive(wire({
    carrierVersion: 1,
    type: "host.registered",
    requestId: hello.requestId,
    connectorId,
    payload: {
      brokerEpoch: "broker-process-uuid",
      hostsRevision: options.hostsRevision ?? "1",
      disposition,
      supersededHostInstanceId: disposition === "replaced"
        ? (options.supersededHostInstanceId ?? "previous-host-process-uuid")
        : null,
      limits: {
        maxCarrierFrameBytes: 1_500_000,
        brokerCarrierBufferedBytes: 16_777_216,
        brokerCarrierLowWaterBytes: 8_388_608,
      },
    },
  }));
  return connectorId;
}

function routeOpen(connectorId, options = {}) {
  const routeId = options.routeId ?? "route-uuid";
  const routeFence = options.routeFence ?? "route-fence-uuid";
  const clientDialect = options.clientDialect ?? "tw-relay.v2";
  const authContext = clientDialect === "tw-relay.v2"
    ? {
        scheme: "twcap2",
        role: "client",
        hostId: "mac-admin",
        principalId: "principal-opaque-id",
        grantId: "client-grant-uuid",
        clientInstanceId: "android-install-uuid",
        jti: "client-token-jti",
        kid: "issuer-key-id",
        expiresAtMs: 1_783_703_600_000,
      }
    : {
        scheme: "legacy_shared_secret",
        role: "client",
        hostId: "mac-admin",
        principalId: null,
        grantId: null,
        clientInstanceId: null,
      };
  return {
    carrierVersion: 1,
    type: "route.open",
    requestId: options.requestId ?? `open-${routeId}`,
    connectorId,
    routeId,
    routeFence,
    payload: {
      connectionId: options.connectionId ?? `connection-${routeId}`,
      clientDialect,
      authContext,
      limits: { maxFrameBytes: options.maxFrameBytes ?? 1_048_576 },
    },
  };
}

function publicV2Frame(requestId = "hosts-request") {
  return codec.encodeRelayV2WebSocketFrame("public", {
    protocolVersion: 2,
    kind: "request",
    type: "hosts.snapshot.get",
    requestId,
    payload: {},
  });
}

function routeData(connectorId, routeId, routeFence, seq, bytes) {
  return {
    carrierVersion: 1,
    type: "route.data",
    connectorId,
    routeId,
    routeFence,
    direction: "client_to_host",
    seq: String(seq),
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
    },
  };
}

function reauthenticated(connectorId, requestId, accessJti, deduplicated = false) {
  return {
    carrierVersion: 1,
    type: "host.reauthenticated",
    requestId,
    connectorId,
    payload: {
      grantId: "host-grant-uuid",
      jti: accessJti,
      expiresAtMs: 1_783_707_200_000,
      deduplicated,
    },
  };
}

test("host route and identity configuration cannot exceed production ceilings", () => {
  assert.throws(() => createHarness({
    queueLimits: { maxRoutes: 257 },
  }), /route limit exceeds the production ceiling/);
  assert.doesNotThrow(() => createHarness({
    queueLimits: { maxRoutes: 256, maxRouteIdentitiesPerConnector: 4_096 },
  }));
  assert.throws(() => createHarness({
    queueLimits: { maxRouteIdentitiesPerConnector: 4_097 },
  }), /route identity limit exceeds the production ceiling/);
});

test("post-publish connect failure rolls back connecting state and scheduled pressure", () => {
  let scheduleCalls = 0;
  const h = createHarness({
    queueLimits: {
      carrierHighWaterBytes: 1_024,
      carrierLowWaterBytes: 512,
      carrierControlReserveBytes: 128,
    },
    schedule() {
      scheduleCalls += 1;
      throw new Error("scheduler unavailable");
    },
  });
  const transport = new FakeTransport();
  let bufferedReads = 0;
  transport.bufferedAmount = () => {
    bufferedReads += 1;
    return bufferedReads === 1 ? 0 : 1_024;
  };

  assert.throws(
    () => h.actor.connect(transport, "credential-1"),
    /scheduler unavailable/,
  );
  assert.equal(scheduleCalls, 1);
  assert.equal(h.actor.status().phase, "offline");
  assert.deepEqual(
    h.statuses.map((status) => status.phase),
    ["connecting", "offline"],
  );
  assert.equal(transport.pendingDeliveries.length, 0);
  assert.doesNotThrow(() => h.actor.connect(new FakeTransport(), "credential-1"));
  assert.equal(h.actor.status().phase, "connecting");
});

test("host.registered is a hard barrier before any client route can bind", () => {
  const h = createHarness();
  const first = connect(h);
  first.connection.receive(wire(routeOpen("premature-connector")));

  assert.equal(h.bound.length, 0);
  assert.deepEqual(first.transport.closes, [{
    code: 4400,
    reason: "registered_barrier_violation",
  }]);
  assert.equal(h.actor.status().phase, "offline");

  const second = connect(h, new FakeTransport());
  const connectorId = register(second.connection, second.hello, {
    connectorId: "registered-connector",
  });
  second.connection.receive(wire(routeOpen(connectorId)));

  assert.equal(h.actor.status().phase, "registered");
  assert.equal(h.bound.length, 1);
  assert.equal(decoded(second.transport.sent).at(-1).type, "route.opened");
});

test("typed CAPABILITY_UNAVAILABLE bind rejection never emits route.opened", () => {
  const h = createHarness({
    onRouteBound: () => ({
      accepted: false,
      code: "CAPABILITY_UNAVAILABLE",
      message: "host readiness was withdrawn",
      retryable: false,
    }),
  });
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));

  const response = decoded(active.transport.sent).at(-1);
  assert.equal(response.type, "route.rejected");
  assert.equal(response.error.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(response.error.retryable, false);
  assert.equal(decoded(active.transport.sent).some(({ type }) => type === "route.opened"), false);
});

test("a pre-registration DUPLICATE_CONNECTOR carrier error closes only the newcomer with 4411", () => {
  const h = createHarness();
  const active = connect(h);
  active.connection.receive(wire({
    carrierVersion: 1,
    type: "carrier.error",
    requestId: active.hello.requestId,
    connectorId: null,
    payload: { failedType: "host.hello" },
    error: {
      code: "DUPLICATE_CONNECTOR",
      message: "The same host process already has an active connector",
      retryable: false,
      retryAfterMs: null,
      commandDisposition: "not_applicable",
      details: null,
    },
  }));
  assert.deepEqual(active.transport.closes, [{
    code: 4411,
    reason: "duplicate_connector",
  }]);
  assert.equal(h.actor.status().phase, "offline");
});

test("v2 route bytes pass the production public codec and negotiated frame limit before reaching the sink", () => {
  const h = createHarness();
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  const valid = publicV2Frame();
  const negotiatedMax = valid.byteLength + 8;
  active.connection.receive(wire(routeOpen(connectorId, {
    maxFrameBytes: negotiatedMax,
  })));
  const binding = h.bound.at(-1);
  const opened = decoded(active.transport.sent).at(-1);
  assert.equal(binding.clientDialect, "tw-relay.v2");
  assert.equal(binding.maxFrameBytes, negotiatedMax);
  assert.equal(opened.payload.maxFrameBytes, negotiatedMax);

  active.connection.receive(wire(routeData(
    connectorId,
    binding.routeId,
    binding.routeFence,
    1,
    valid,
  )));
  assert.equal(h.received.length, 1);
  assert.deepEqual(h.received[0].payload, valid);

  active.connection.receive(wire(routeData(
    connectorId,
    binding.routeId,
    binding.routeFence,
    2,
    Uint8Array.from([0xff]),
  )));
  assert.equal(h.received.length, 1);
  assert.deepEqual(active.transport.closes.at(-1), {
    code: 4400,
    reason: "invalid_public_route_frame",
  });
});

test("route.data text validation precedes negotiated preflight and its only decoded allocation", () => {
  let oversizeDecoderCalls = 0;
  const oversize = createHarness({
    publicPayloadDecoder: {
      decodeCanonicalBase64() {
        oversizeDecoderCalls += 1;
        throw new Error("oversize payload reached the decoder");
      },
    },
  });
  const oversizeActive = connect(oversize);
  const oversizeConnectorId = register(oversizeActive.connection, oversizeActive.hello);
  const negotiatedMax = 128;
  oversizeActive.connection.receive(wire(routeOpen(
    oversizeConnectorId,
    { maxFrameBytes: negotiatedMax },
  )));
  const oversizeBinding = oversize.bound.at(-1);

  oversizeActive.connection.receive(wire(routeData(
    oversizeConnectorId,
    oversizeBinding.routeId,
    oversizeBinding.routeFence,
    1,
    Buffer.alloc(negotiatedMax + 1, 0x61),
  )));

  assert.equal(oversizeDecoderCalls, 0);
  assert.equal(oversize.received.length, 0);
  assert.deepEqual(oversizeActive.transport.closes.at(-1), {
    code: 4400,
    reason: "route_frame_limit",
  });

  let legalDecoderCalls = 0;
  const legal = createHarness({
    publicPayloadDecoder: {
      decodeCanonicalBase64(encoded) {
        legalDecoderCalls += 1;
        return Buffer.from(encoded, "base64");
      },
    },
  });
  const legalActive = connect(legal);
  const legalConnectorId = register(legalActive.connection, legalActive.hello);
  const legalBytes = publicV2Frame("decode-once");
  legalActive.connection.receive(wire(routeOpen(legalConnectorId, {
    maxFrameBytes: legalBytes.byteLength,
  })));
  const legalBinding = legal.bound.at(-1);
  legalActive.connection.receive(wire(routeData(
    legalConnectorId,
    legalBinding.routeId,
    legalBinding.routeFence,
    1,
    legalBytes,
  )));
  assert.equal(legalDecoderCalls, 1);
  assert.equal(legal.received.length, 1);
  assert.deepEqual(legal.received[0].payload, legalBytes);

  let malformedDecoderCalls = 0;
  const malformed = createHarness({
    publicPayloadDecoder: {
      decodeCanonicalBase64() {
        malformedDecoderCalls += 1;
        throw new Error("malformed payload reached the decoder");
      },
    },
  });
  const malformedActive = connect(malformed);
  const malformedConnectorId = register(malformedActive.connection, malformedActive.hello);
  malformedActive.connection.receive(wire(routeOpen(malformedConnectorId, {
    maxFrameBytes: 128,
  })));
  const malformedBinding = malformed.bound.at(-1);
  const malformedFrame = routeData(
    malformedConnectorId,
    malformedBinding.routeId,
    malformedBinding.routeFence,
    1,
    Buffer.from("M"),
  );
  malformedFrame.payload.data = "TR==";
  malformedActive.connection.receive(Buffer.from(JSON.stringify(malformedFrame), "utf8"));
  assert.equal(malformedDecoderCalls, 0);
  assert.equal(malformed.received.length, 0);
  assert.deepEqual(malformedActive.transport.closes.at(-1), {
    code: 4400,
    reason: "invalid_carrier_frame",
  });
});

test("an exact route binding keeps contiguous direction sequences through unbind", () => {
  const h = createHarness();
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);

  active.connection.receive(wire(routeData(
    connectorId,
    binding.routeId,
    binding.routeFence,
    1,
    publicV2Frame("client-sequence-1"),
  )));
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("host-sequence-1")), true);
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("host-sequence-2")), true);

  active.connection.receive(wire({
    carrierVersion: 1,
    type: "route.unbind",
    connectorId,
    routeId: binding.routeId,
    routeFence: binding.routeFence,
    payload: {
      reason: "client_closed",
      lastClientToHostSeq: "1",
    },
  }));

  assert.equal(h.received.length, 1);
  assert.equal(h.unbound.at(-1).reason, "client_closed");
  const unbound = decoded(active.transport.sent).at(-1);
  assert.equal(unbound.type, "route.unbound");
  assert.equal(unbound.payload.lastClientToHostSeq, "1");
  assert.equal(unbound.payload.lastHostToClientSeq, "2");
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("after-unbind")), false);
});

test("route.unbound reports only the contiguous transport-emitted host watermark", () => {
  const h = createHarness();
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);
  const baseline = active.transport.sent.length;

  active.transport.accepting = false;
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("queued-not-emitted")), true);
  assert.equal(active.transport.sent.length, baseline);
  active.connection.receive(wire({
    carrierVersion: 1,
    type: "route.unbind",
    connectorId,
    routeId: binding.routeId,
    routeFence: binding.routeFence,
    payload: {
      reason: "client_closed",
      lastClientToHostSeq: "0",
    },
  }));

  active.transport.accepting = true;
  active.connection.writable();
  const emitted = decoded(active.transport.sent.slice(baseline));
  assert.deepEqual(emitted.map((frame) => frame.type), ["route.unbound"]);
  assert.equal(emitted[0].payload.lastHostToClientSeq, "0");
  assert.equal(h.unbound.at(-1).reason, "client_closed");
});

test("an explicitly configured v1 dialect uses only its own validator and preserves original bytes", () => {
  const v1Adapter = {
    validate(payload) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.type !== "string") throw new Error("invalid v1 frame");
    },
  };
  const h = createHarness({
    clientDialects: ["tw-relay.v1", "tw-relay.v2"],
    dialectAdapters: { "tw-relay.v1": v1Adapter },
  });
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId, {
    clientDialect: "tw-relay.v1",
  })));
  const binding = h.bound.at(-1);
  const valid = new TextEncoder().encode('{"type":"list_sessions"}');
  active.connection.receive(wire(routeData(
    connectorId,
    binding.routeId,
    binding.routeFence,
    1,
    valid,
  )));
  assert.equal(binding.clientDialect, "tw-relay.v1");
  assert.deepEqual(h.received.at(-1).payload, valid);
  active.connection.receive(wire(routeData(
    connectorId,
    binding.routeId,
    binding.routeFence,
    2,
    Uint8Array.from([0xff]),
  )));
  assert.equal(h.received.length, 1);
  assert.equal(active.transport.closes.at(-1).reason, "invalid_public_route_frame");
});

test("sendPublic validates bytes with the bound route dialect before carrier enqueue", async (t) => {
  for (const clientDialect of ["tw-relay.v2", "tw-relay.v1"]) {
    await t.test(clientDialect, () => {
      let v1ValidationCalls = 0;
      const dialectAdapters = clientDialect === "tw-relay.v1"
        ? {
            "tw-relay.v1": {
              validate(payload) {
                v1ValidationCalls += 1;
                const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
                const parsed = JSON.parse(text);
                if (!parsed || typeof parsed.type !== "string") throw new Error("invalid v1 frame");
              },
            },
          }
        : undefined;
      const h = createHarness({
        clientDialects: [clientDialect],
        dialectAdapters,
      });
      const active = connect(h);
      const connectorId = register(active.connection, active.hello);
      active.connection.receive(wire(routeOpen(connectorId, { clientDialect })));
      const binding = h.bound.at(-1);
      const baseline = active.transport.sent.length;
      const valid = clientDialect === "tw-relay.v2"
        ? publicV2Frame("outbound-validated")
        : new TextEncoder().encode('{"type":"list_sessions"}');

      assert.equal(h.actor.sendPublic(binding, valid), true);
      if (clientDialect === "tw-relay.v1") assert.equal(v1ValidationCalls, 1);
      assert.equal(h.actor.sendPublic(binding, Uint8Array.from([0xff])), false);
      if (clientDialect === "tw-relay.v1") assert.equal(v1ValidationCalls, 2);
      assert.deepEqual(h.closing.map((entry) => entry.code), ["INTERNAL"]);
      const dataFrames = decoded(active.transport.sent.slice(baseline)).filter((frame) => (
        frame.type === "route.data"
      ));
      assert.equal(dataFrames.length, 1);
      assert.deepEqual(
        Uint8Array.from(Buffer.from(dataFrames[0].payload.data, "base64")),
        valid,
      );
    });
  }
});

test("wrong current-carrier connector, route, fence, or sequence closes that source without delivery", async (t) => {
  const cases = [
    {
      name: "connector",
      mutate(frame) { frame.connectorId = "stale-connector"; },
      reason: "stale_connector_source",
    },
    {
      name: "route",
      mutate(frame) { frame.routeId = "stale-route"; },
      reason: "stale_route_source",
    },
    {
      name: "fence",
      mutate(frame) { frame.routeFence = "stale-fence"; },
      reason: "stale_route_source",
    },
    {
      name: "sequence",
      mutate(frame) { frame.seq = "2"; },
      reason: "carrier_sequence_violation",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const h = createHarness();
      const active = connect(h);
      const connectorId = register(active.connection, active.hello);
      active.connection.receive(wire(routeOpen(connectorId)));
      const binding = h.bound.at(-1);
      const frame = routeData(
        connectorId,
        binding.routeId,
        binding.routeFence,
        1,
        publicV2Frame(),
      );
      scenario.mutate(frame);
      active.connection.receive(wire(frame));
      assert.equal(h.received.length, 0);
      assert.deepEqual(active.transport.closes.at(-1), {
        code: 4400,
        reason: scenario.reason,
      });
    });
  }
});

test("late callbacks from a replaced connector generation cannot affect the winner", () => {
  const h = createHarness();
  const first = connect(h);
  const firstConnectorId = register(first.connection, first.hello, {
    connectorId: "connector-first",
  });
  first.connection.receive(wire(routeOpen(firstConnectorId, {
    routeId: "route-first",
    routeFence: "fence-first",
  })));
  const firstBinding = h.bound.at(-1);

  const second = connect(h, new FakeTransport());
  const secondConnectorId = register(second.connection, second.hello, {
    connectorId: "connector-second",
  });
  second.connection.receive(wire(routeOpen(secondConnectorId, {
    routeId: "route-second",
    routeFence: "fence-second",
  })));
  const secondBinding = h.bound.at(-1);

  first.connection.receive(wire(routeData(
    firstConnectorId,
    firstBinding.routeId,
    firstBinding.routeFence,
    1,
    publicV2Frame("stale-request"),
  )));
  first.connection.closed(1006);
  assert.equal(h.actor.sendPublic(firstBinding, publicV2Frame()), false);
  assert.equal(h.actor.status().connectorId, "connector-second");

  second.connection.receive(wire(routeData(
    secondConnectorId,
    secondBinding.routeId,
    secondBinding.routeFence,
    1,
    publicV2Frame("winner-request"),
  )));
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].binding, secondBinding);
});

test("connector replacement and broker supersede are atomic and never report a false offline winner", () => {
  const h = createHarness();
  const first = connect(h);
  register(first.connection, first.hello, { connectorId: "connector-loser" });
  first.transport.onClose = (code) => first.connection.closed(code);

  const secondTransport = new FakeTransport();
  const second = connect(h, secondTransport);
  secondTransport.onClose = (code) => second.connection.closed(code);
  register(second.connection, second.hello, {
    connectorId: "connector-winner",
    disposition: "replaced",
    supersededHostInstanceId: "previous-host-process-uuid",
  });
  first.connection.closed(1006);

  assert.equal(h.actor.status().phase, "registered");
  assert.equal(h.actor.status().connectorId, "connector-winner");
  assert.equal(h.statuses.some((status) => status.phase === "offline"), false);

  second.connection.receive(wire({
    carrierVersion: 1,
    type: "host.superseded",
    connectorId: "connector-winner",
    payload: {
      hostId: "mac-admin",
      losingConnectorId: "connector-winner",
      winningConnectorId: "connector-new-process",
      losingHostInstanceId: "host-process-uuid",
      winningHostInstanceId: "new-host-process-uuid",
      reason: "new_authenticated_connector",
    },
  }));

  assert.equal(h.actor.status().phase, "superseded");
  assert.equal(h.statuses.at(-1).phase, "superseded");
  assert.equal(h.statuses.some((status) => status.phase === "offline"), false);
  assert.throws(
    () => h.actor.connect(new FakeTransport(), "credential-1"),
    /superseded and cannot reconnect/,
  );
});

test("reauthentication uses only a descriptor-safe durable winner", async (t) => {
  function registeredHarness(prepared = preparedReauthentication()) {
    const h = createHarness();
    h.credentials.add("credential-2", "2", "access-jti-2");
    h.credentials.prepareResult = prepared;
    const active = connect(h);
    const connectorId = register(active.connection, active.hello);
    acknowledgeAll(active.connection, active.transport);
    return { h, active, connectorId };
  }

  await t.test("prepare completes before transport and its winner overrides caller input", () => {
    const prepared = preparedReauthentication({ requestId: "durable-reauth-2" });
    const { h, active, connectorId } = registeredHarness(prepared);
    active.transport.onTrySend = (_deliveryToken, bytes) => {
      const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
      if (frame.type === "host.reauthenticate") {
        assert.equal(h.credentials.prepareCalls.length, 1);
      }
    };

    assert.equal(
      h.actor.requestReauthentication("caller-must-not-win", "credential-2"),
      true,
    );
    assert.deepEqual(h.credentials.prepareCalls, [{
      credentialReference: "credential-2",
      requestId: "caller-must-not-win",
    }]);
    const sentReauthentication = decoded(active.transport.sent).at(-1);
    assert.equal(sentReauthentication.carrierVersion, 1);
    assert.equal(sentReauthentication.type, "host.reauthenticate");
    assert.equal(sentReauthentication.requestId, "durable-reauth-2");
    assert.equal(sentReauthentication.connectorId, connectorId);
    assert.equal(sentReauthentication.payload.accessToken, prepared.accessToken);

    h.credentials.ackResult = true;
    active.connection.receive(wire(reauthenticated(
      connectorId,
      "durable-reauth-2",
      "access-jti-2",
    )));
    assert.deepEqual(h.credentials.ackCalls, [{ ...prepared.fence }]);
  });

  await t.test("authority ACK rejection preserves the volatile winner", () => {
    const prepared2 = preparedReauthentication();
    const { h, active, connectorId } = registeredHarness(prepared2);
    assert.equal(h.actor.requestReauthentication("caller-2", "credential-2"), true);

    const prepared3 = preparedReauthentication({
      reference: "credential-3",
      version: "3",
      requestId: "reauth-3",
      accessJti: "access-jti-3",
    });
    h.credentials.prepareResult = prepared3;
    assert.equal(h.actor.requestReauthentication("caller-3", "credential-3"), true);
    active.connection.receive(wire(reauthenticated(
      connectorId,
      prepared2.fence.requestId,
      prepared2.fence.accessJti,
    )));
    assert.equal(h.credentials.ackCalls.length, 0, "stale ACK is not presented");

    h.credentials.ackResult = false;
    const exactAck = reauthenticated(
      connectorId,
      prepared3.fence.requestId,
      prepared3.fence.accessJti,
    );
    active.connection.receive(wire(exactAck));
    assert.deepEqual(h.credentials.ackCalls, [{ ...prepared3.fence }]);
    h.credentials.ackResult = true;
    active.connection.receive(wire(exactAck));
    assert.deepEqual(h.credentials.ackCalls, [
      { ...prepared3.fence },
      { ...prepared3.fence },
    ]);
    active.connection.receive(wire({
      ...exactAck,
      payload: { ...exactAck.payload, deduplicated: true },
    }));
    assert.equal(h.credentials.ackCalls.length, 2, "successful ACK clears only once");
  });

  await t.test("prepare failure cannot enqueue or trigger repair", () => {
    const { h, active } = registeredHarness();
    h.credentials.prepareError = new Error("durable prepare failed");
    const sentBefore = active.transport.sent.length;
    assert.throws(
      () => h.actor.requestReauthentication("caller-id", "credential-2"),
      /durable prepare failed/,
    );
    active.connection.writable();
    assert.equal(active.transport.sent.length, sentBefore);
    assert.equal(h.credentials.prepareCalls.length, 1);
    assert.equal(h.credentials.ackCalls.length, 0);
  });

  await t.test("a nested preparation invalidates its outer lease without overwriting the old winner", () => {
    const oldWinner = preparedReauthentication({ requestId: "durable-old" });
    const { h, active, connectorId } = registeredHarness(oldWinner);
    assert.equal(h.actor.requestReauthentication("caller-old", "credential-2"), true);
    const sentBefore = active.transport.sent.length;

    const hostileWinner = preparedReauthentication({
      version: "3",
      requestId: "durable-hostile",
      accessJti: "access-jti-3",
    });
    h.credentials.onPrepare = () => {
      assert.throws(
        () => h.actor.requestReauthentication("nested", "credential-2"),
        /preparation was reentered/,
      );
      return hostileWinner;
    };
    assert.equal(
      h.actor.requestReauthentication("caller-hostile", "credential-2"),
      false,
    );
    assert.equal(h.credentials.prepareCalls.length, 2, "nested call never reaches authority");
    assert.equal(active.transport.sent.length, sentBefore, "no hostile frame is admitted");

    h.credentials.ackResult = true;
    active.connection.receive(wire(reauthenticated(
      connectorId,
      oldWinner.fence.requestId,
      oldWinner.fence.accessJti,
    )));
    assert.deepEqual(
      h.credentials.ackCalls,
      [{ ...oldWinner.fence }],
      "the invalidated attempt cannot overwrite the previous pending winner",
    );
  });

  await t.test("a reentrant Proxy descriptor trap cannot reach authority twice or enqueue", () => {
    const { h, active, connectorId } = registeredHarness();
    const winner = preparedReauthentication({ requestId: "proxy-attempt" });
    let descriptorTrapCalls = 0;
    h.credentials.prepareResult = new Proxy(winner, {
      getPrototypeOf(target) {
        descriptorTrapCalls += 1;
        assert.throws(
          () => h.actor.requestReauthentication("proxy-nested", "credential-2"),
          /preparation was reentered/,
        );
        return Reflect.getPrototypeOf(target);
      },
    });
    const sentBefore = active.transport.sent.length;

    assert.equal(h.actor.requestReauthentication("proxy-outer", "credential-2"), false);
    assert.equal(descriptorTrapCalls, 1);
    assert.equal(h.credentials.prepareCalls.length, 1);
    assert.equal(active.transport.sent.length, sentBefore);
    active.connection.receive(wire(reauthenticated(
      connectorId,
      winner.fence.requestId,
      winner.fence.accessJti,
    )));
    assert.equal(h.credentials.ackCalls.length, 0, "no volatile pending fence was written");
  });

  await t.test("close and re-register during prepare invalidate only the old connector lease", () => {
    const { h, active } = registeredHarness();
    const staleWinner = preparedReauthentication({ requestId: "stale-after-close" });
    let replacement;
    let replacementConnectorId;
    h.credentials.onPrepare = () => {
      active.connection.closed(1006);
      replacement = connect(h, new FakeTransport());
      replacementConnectorId = register(replacement.connection, replacement.hello, {
        connectorId: "connector-replacement",
      });
      acknowledgeAll(replacement.connection, replacement.transport);
      return staleWinner;
    };
    const oldSentBefore = active.transport.sent.length;

    assert.equal(h.actor.requestReauthentication("outer-close", "credential-2"), false);
    assert.equal(active.transport.sent.length, oldSentBefore);
    assert.ok(replacement);
    assert.equal(
      decoded(replacement.transport.sent).some((frame) => frame.type === "host.reauthenticate"),
      false,
    );
    replacement.connection.receive(wire(reauthenticated(
      replacementConnectorId,
      staleWinner.fence.requestId,
      staleWinner.fence.accessJti,
    )));
    assert.equal(h.credentials.ackCalls.length, 0, "stale preparation creates no pending ACK fence");

    const freshWinner = preparedReauthentication({
      version: "4",
      requestId: "fresh-after-close",
      accessJti: "access-jti-4",
    });
    h.credentials.onPrepare = undefined;
    h.credentials.prepareResult = freshWinner;
    assert.equal(h.actor.requestReauthentication("fresh-caller", "credential-2"), true);
    const freshFrame = decoded(replacement.transport.sent).at(-1);
    assert.equal(freshFrame.carrierVersion, 1);
    assert.equal(freshFrame.type, "host.reauthenticate");
    assert.equal(freshFrame.requestId, freshWinner.fence.requestId);
    assert.equal(freshFrame.connectorId, replacementConnectorId);
    assert.equal(freshFrame.payload.accessToken, freshWinner.accessToken);
  });

  for (const scenario of [
    {
      name: "missing field",
      make() { return { fence: preparedReauthentication().fence }; },
      error: /preparation is invalid/,
    },
    {
      name: "outer accessor",
      make(state) {
        const result = { fence: preparedReauthentication().fence };
        Object.defineProperty(result, "accessToken", {
          enumerable: true,
          get() {
            state.getterReads += 1;
            return "twcap2.hostile-outer.payload.mac";
          },
        });
        return result;
      },
      error: /preparation is invalid/,
    },
    {
      name: "fence accessor",
      make(state) {
        const normal = preparedReauthentication();
        const fence = { ...normal.fence };
        Object.defineProperty(fence, "accessJti", {
          enumerable: true,
          get() {
            state.getterReads += 1;
            return "hostile-access-jti";
          },
        });
        return { fence, accessToken: normal.accessToken };
      },
      error: /preparation is invalid/,
    },
    {
      name: "symbol extension",
      make() {
        const result = preparedReauthentication();
        result[Symbol("extra")] = true;
        return result;
      },
      error: /preparation is invalid/,
    },
    {
      name: "string extension",
      make() {
        return { ...preparedReauthentication(), extra: true };
      },
      error: /preparation is invalid/,
    },
    {
      name: "non-plain fence",
      make() {
        const normal = preparedReauthentication();
        return {
          fence: Object.assign(Object.create(null), normal.fence),
          accessToken: normal.accessToken,
        };
      },
      error: /preparation is invalid/,
    },
    {
      name: "grant conflict",
      make() {
        return preparedReauthentication({ grantId: "different-host-grant" });
      },
      error: /cannot change the host grant/,
    },
  ]) {
    await t.test(`${scenario.name} fails closed before enqueue`, () => {
      const state = { getterReads: 0 };
      const { h, active } = registeredHarness(scenario.make(state));
      const sentBefore = active.transport.sent.length;
      assert.throws(
        () => h.actor.requestReauthentication("caller-id", "credential-2"),
        scenario.error,
      );
      active.connection.writable();
      assert.equal(state.getterReads, 0);
      assert.equal(active.transport.sent.length, sentBefore);
      assert.equal(h.credentials.prepareCalls.length, 1);
      assert.equal(h.credentials.ackCalls.length, 0);
    });
  }

  for (const scenario of [
    {
      name: "trySend refusal",
      expectedAttempts: 1,
      accept(frame) { return frame.type !== "host.reauthenticate"; },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), false);
        active.connection.writable();
      },
    },
    {
      name: "trySend throw",
      expectedAttempts: 1,
      accept(frame) {
        if (frame.type === "host.reauthenticate") throw new Error("transport failed");
        return true;
      },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), false);
        active.connection.writable();
      },
    },
    {
      name: "queued but never attempted",
      expectedAttempts: 0,
      accept(frame) { return frame.type !== "route.close"; },
      run({ h, active, connectorId }) {
        active.connection.receive(wire(routeOpen(connectorId)));
        const binding = h.bound.at(-1);
        acknowledgeAll(active.connection, active.transport);
        assert.equal(h.actor.closeRoute(binding), true);
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), true);
        active.connection.closed(1006);
        active.connection.writable();
      },
    },
    {
      name: "in-flight reject",
      expectedAttempts: 1,
      accept() { return true; },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), true);
        active.connection.rejectUnaccepted(
          active.transport.pendingDeliveries.at(-1).deliveryToken,
        );
        active.connection.writable();
      },
    },
    {
      name: "in-flight close",
      expectedAttempts: 1,
      accept() { return true; },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), true);
        active.connection.closed(1006);
        active.connection.writable();
      },
    },
    {
      name: "reentrant close",
      expectedAttempts: 1,
      accept() { return true; },
      before({ active }) {
        active.transport.onTrySend = (_deliveryToken, bytes) => {
          const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
          if (frame.type === "host.reauthenticate") active.connection.closed(1006);
        };
      },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), false);
        active.connection.writable();
      },
    },
    {
      name: "reentrant transport ACK",
      expectedAttempts: 1,
      accept() { return true; },
      before({ active }) {
        active.transport.onTrySend = (_deliveryToken, bytes) => {
          const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
          if (frame.type !== "host.reauthenticate") return;
          active.connection.acknowledge(active.transport.confirmNext());
        };
      },
      run({ h, active }) {
        assert.equal(h.actor.requestReauthentication("caller-id", "credential-2"), false);
        active.connection.writable();
      },
    },
  ]) {
    await t.test(`${scenario.name} never retries or acknowledges`, () => {
      const context = registeredHarness();
      let reauthenticationAttempts = 0;
      context.active.transport.acceptFrame = (bytes) => {
        const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
        if (frame.type === "host.reauthenticate") reauthenticationAttempts += 1;
        return scenario.accept(frame);
      };
      scenario.before?.(context);
      scenario.run(context);
      assert.equal(reauthenticationAttempts, scenario.expectedAttempts);
      assert.equal(context.h.credentials.prepareCalls.length, 1);
      assert.equal(context.h.credentials.ackCalls.length, 0);
    });
  }
});

test("the actor retains refused frames and retries once per ACK or writable signal", () => {
  const h = createHarness();
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);
  const baseline = active.transport.sent.length;

  assert.equal(h.actor.sendPublic(binding, publicV2Frame("accepted-first")), true);
  const firstFrameBytes = active.transport.sent.at(-1).byteLength;
  active.transport.accepting = false;
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("actor-owned-retry")), true);
  assert.equal(active.transport.sent.length, baseline + 1);

  const attemptsBeforeAck = active.transport.attempts;
  active.connection.acknowledge(active.transport.confirmNext(firstFrameBytes));
  assert.equal(active.transport.attempts, attemptsBeforeAck + 1);
  active.connection.writable();
  assert.equal(active.transport.attempts, attemptsBeforeAck + 2);
  assert.equal(active.transport.sent.length, baseline + 1);

  active.transport.accepting = true;
  active.connection.writable();
  const delivered = decoded(active.transport.sent.slice(baseline));
  assert.deepEqual(delivered.map((frame) => frame.seq), ["1", "2"]);
});

test("round-robin data scheduling lets a healthy route pass a blocked route", () => {
  const h = createHarness();
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId, {
    routeId: "route-a",
    routeFence: "fence-a",
  })));
  active.connection.receive(wire(routeOpen(connectorId, {
    routeId: "route-b",
    routeFence: "fence-b",
  })));
  const routeA = h.bound.find((binding) => binding.routeId === "route-a");
  const routeB = h.bound.find((binding) => binding.routeId === "route-b");
  acknowledgeAll(active.connection, active.transport);
  const baseline = active.transport.sent.length;
  active.transport.acceptFrame = (bytes) => {
    const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
    return frame.type !== "route.data" || frame.routeId !== routeA.routeId;
  };

  assert.equal(h.actor.sendPublic(routeA, publicV2Frame("a-1")), true);
  assert.equal(h.actor.sendPublic(routeA, publicV2Frame("a-2")), true);
  assert.equal(h.actor.sendPublic(routeB, publicV2Frame("b-1")), true);
  assert.equal(h.actor.sendPublic(routeB, publicV2Frame("b-2")), true);
  let data = decoded(active.transport.sent.slice(baseline)).filter((frame) => (
    frame.type === "route.data"
  ));
  assert.deepEqual(data.map((frame) => [frame.routeId, frame.seq]), [
    ["route-b", "1"],
    ["route-b", "2"],
  ]);

  active.transport.acceptFrame = undefined;
  active.connection.writable();
  data = decoded(active.transport.sent.slice(baseline)).filter((frame) => (
    frame.type === "route.data"
  ));
  assert.deepEqual(data.map((frame) => [frame.routeId, frame.seq]), [
    ["route-b", "1"],
    ["route-b", "2"],
    ["route-a", "1"],
    ["route-a", "2"],
  ]);
  assert.deepEqual(active.transport.closes, []);
});

test("delivery-token ACKs reject premature, out-of-order, and reentrant release", async (t) => {
  async function withOpenRoute(run) {
    const h = createHarness();
    const active = connect(h);
    const connectorId = register(active.connection, active.hello);
    active.connection.receive(wire(routeOpen(connectorId)));
    const binding = h.bound.at(-1);
    acknowledgeAll(active.connection, active.transport);
    await run({ h, active, binding });
  }

  await t.test("premature", () => withOpenRoute(({ h, active, binding }) => {
    assert.equal(h.actor.sendPublic(binding, publicV2Frame("premature")), true);
    const token = active.transport.pendingDeliveries[0].deliveryToken;
    active.connection.acknowledge(token);
    assert.deepEqual(active.transport.closes.at(-1), {
      code: 4400,
      reason: "premature_transport_ack",
    });
    assert.equal(h.actor.sendPublic(binding, publicV2Frame("cannot-bypass-limit")), false);
  }));

  await t.test("out-of-order", () => withOpenRoute(({ h, active, binding }) => {
    assert.equal(h.actor.sendPublic(binding, publicV2Frame("fifo-1")), true);
    assert.equal(h.actor.sendPublic(binding, publicV2Frame("fifo-2")), true);
    active.connection.acknowledge(active.transport.pendingDeliveries[1].deliveryToken);
    assert.deepEqual(active.transport.closes.at(-1), {
      code: 4400,
      reason: "invalid_transport_ack",
    });
  }));

  await t.test("reentrant", () => withOpenRoute(({ h, active, binding }) => {
    active.transport.onTrySend = (deliveryToken) => {
      active.connection.acknowledge(deliveryToken);
    };
    assert.equal(h.actor.sendPublic(binding, publicV2Frame("reentrant")), false);
    assert.deepEqual(active.transport.closes.at(-1), {
      code: 4400,
      reason: "reentrant_transport_ack",
    });
  }));
});

test("socket-accepted bytes remain charged until ACK; low water recovers and five-second pressure closes", () => {
  let now = 1_000;
  const timers = [];
  const payload = publicV2Frame("pressure-a");
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    queueLimits: {
      maxQueuedDataFramesPerRoute: 8,
      maxQueuedDataFrames: 16,
      maxQueuedControlFrames: 8,
      carrierHighWaterBytes: 16_384,
      carrierLowWaterBytes: 8_192,
      carrierControlReserveBytes: 512,
      routeHighWaterBytes: payload.byteLength * 2,
      routeLowWaterBytes: payload.byteLength,
    },
  });
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);
  const baseline = active.transport.sent.length;

  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-a")), true);
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-b")), true);
  assert.ok(active.transport.bufferedAmount() > 0);
  const boundaryTimer = timers.findLast((timer) => !timer.cancelled);
  assert.equal(boundaryTimer.delayMs, 5_000, "exact route high water starts pressure");
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-c")), false);
  assert.deepEqual(h.closing, [], "high water stops admission but does not close immediately");

  now = 5_999;
  active.connection.writable();
  assert.deepEqual(h.closing, []);

  const firstDataBytes = active.transport.sent[baseline].byteLength;
  active.connection.acknowledge(active.transport.confirmNext(firstDataBytes));
  assert.equal(boundaryTimer.cancelled, false, "equality is not below route low water");
  const secondDataBytes = active.transport.sent[baseline + 1].byteLength;
  active.connection.acknowledge(active.transport.confirmNext(secondDataBytes));
  assert.equal(boundaryTimer.cancelled, true);
  now = 7_000;
  active.connection.writable();
  assert.deepEqual(h.closing, [], "crossing low water clears the first pressure interval");

  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-c")), true);
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-d")), true);
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-e")), false);
  assert.deepEqual(h.closing, []);
  now = 12_000;
  const pressureTimer = timers.findLast((timer) => !timer.cancelled);
  assert.equal(pressureTimer.delayMs, 5_000);
  pressureTimer.callback();

  assert.deepEqual(h.closing.map((entry) => entry.code), ["SLOW_CONSUMER"]);
  const sent = decoded(active.transport.sent.slice(baseline));
  assert.deepEqual(
    sent.filter((frame) => frame.type === "route.data").map((frame) => frame.seq),
    ["1", "2", "3", "4"],
  );
  assert.equal(sent.at(-1).type, "route.close");
  assert.equal(sent.at(-1).payload.reason, "slow_consumer");
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("pressure-f")), false);
});

test("exact combined carrier high water starts a fence and ACK below low water cancels it", () => {
  let now = 2_000;
  const timers = [];
  const helloBytes = wire({
    carrierVersion: 1,
    type: "host.hello",
    requestId: "host-hello-1",
    payload: {
      hostId: "mac-admin",
      hostEpoch: "authority-uuid",
      hostInstanceId: "host-process-uuid",
      clientDialects: ["tw-relay.v2"],
      capabilities: [],
      limits: {
        maxFrameBytes: 1_048_576,
        terminalMaxFrameBytes: 65_536,
      },
    },
  }).byteLength;
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    queueLimits: {
      carrierHighWaterBytes: helloBytes,
      carrierLowWaterBytes: Math.max(1, Math.floor(helloBytes / 2)),
      carrierControlReserveBytes: 1,
    },
  });
  const active = connect(h);
  assert.equal(active.transport.bufferedAmount(), helloBytes);
  const boundaryTimer = timers.findLast((timer) => !timer.cancelled);
  assert.equal(boundaryTimer.delayMs, 5_000);

  active.connection.acknowledge(active.transport.confirmNext(helloBytes));
  assert.equal(boundaryTimer.cancelled, true);
  now += 5_000;
  boundaryTimer.callback();
  assert.deepEqual(h.closing, []);
  assert.deepEqual(active.transport.closes, []);
});

test("carrier pressure remains fenced while outstanding bytes equal low water", () => {
  let now = 4_000;
  const timers = [];
  const payload = publicV2Frame("carrier-low-a");
  const carrierFrameBytes = wire({
    carrierVersion: 1,
    type: "route.data",
    connectorId: "connector-uuid",
    routeId: "route-uuid",
    routeFence: "route-fence-uuid",
    direction: "host_to_client",
    seq: "1",
    payload: {
      opcode: "text",
      encoding: "base64",
      data: Buffer.from(payload).toString("base64"),
    },
  }).byteLength;
  const controlReserve = 1_024;
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    queueLimits: {
      carrierHighWaterBytes: carrierFrameBytes * 2 + controlReserve,
      carrierLowWaterBytes: carrierFrameBytes,
      carrierControlReserveBytes: controlReserve,
      routeHighWaterBytes: payload.byteLength * 3,
      routeLowWaterBytes: payload.byteLength * 2,
    },
  });
  const active = connect(h);
  acknowledgeAll(active.connection, active.transport);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);

  assert.equal(h.actor.sendPublic(binding, publicV2Frame("carrier-low-a")), true);
  assert.equal(h.actor.sendPublic(binding, publicV2Frame("carrier-low-b")), true);
  const boundaryTimer = timers.findLast((timer) => !timer.cancelled);
  assert.equal(boundaryTimer.delayMs, 5_000);

  active.connection.acknowledge(active.transport.confirmNext(carrierFrameBytes));
  assert.equal(active.transport.bufferedAmount(), carrierFrameBytes);
  assert.equal(boundaryTimer.cancelled, false);
  active.connection.acknowledge(active.transport.confirmNext(carrierFrameBytes));
  assert.equal(boundaryTimer.cancelled, true);
  now += 5_000;
  boundaryTimer.callback();
  assert.deepEqual(h.closing, []);
  assert.deepEqual(active.transport.closes, []);
});

test("an ACK crossing low water at the pressure deadline is charged before evaluation", () => {
  let now = 8_000;
  const timers = [];
  const helloBytes = wire({
    carrierVersion: 1,
    type: "host.hello",
    requestId: "host-hello-1",
    payload: {
      hostId: "mac-admin",
      hostEpoch: "authority-uuid",
      hostInstanceId: "host-process-uuid",
      clientDialects: ["tw-relay.v2"],
      capabilities: [],
      limits: { maxFrameBytes: 1_048_576, terminalMaxFrameBytes: 65_536 },
    },
  }).byteLength;
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    queueLimits: {
      carrierHighWaterBytes: helloBytes,
      carrierLowWaterBytes: Math.max(1, Math.floor(helloBytes / 2)),
      carrierControlReserveBytes: 1,
    },
  });
  const active = connect(h);
  const deadline = timers.findLast((timer) => !timer.cancelled);
  assert.equal(deadline.delayMs, 5_000);

  now += 5_000;
  active.connection.acknowledge(active.transport.confirmNext(helloBytes));

  assert.equal(deadline.cancelled, true);
  assert.deepEqual(active.transport.closes, []);
  assert.equal(h.actor.status().phase, "connecting");
});

test("an unbound route with a lost transport ACK has a carrier-level liveness fence", () => {
  let now = 9_000;
  const timers = [];
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);

  assert.equal(h.actor.sendPublic(binding, publicV2Frame("lost-route-ack")), true);
  active.connection.receive(wire({
    carrierVersion: 1,
    type: "route.unbind",
    connectorId,
    routeId: binding.routeId,
    routeFence: binding.routeFence,
    payload: { reason: "client_closed", lastClientToHostSeq: "0" },
  }));
  const watchdog = timers.findLast((timer) => !timer.cancelled);
  assert.equal(watchdog.delayMs, 5_000);

  now += 5_000;
  watchdog.callback();

  assert.deepEqual(active.transport.closes.at(-1), {
    code: 1013,
    reason: "carrier_pressure_timeout",
  });
  assert.equal(h.actor.status().phase, "offline");
  assert.equal(h.unbound.at(-1).reason, "client_closed");
});

test("global pressure closes the actual occupying route, not a later rejected healthy route", () => {
  let now = 3_000;
  const timers = [];
  const h = createHarness({
    clock: () => now,
    schedule: (delayMs, callback) => {
      const timer = { delayMs, callback, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    queueLimits: {
      maxQueuedDataFramesPerRoute: 16,
      maxQueuedDataFrames: 16,
      maxQueuedControlFrames: 8,
      carrierHighWaterBytes: 1_600,
      carrierLowWaterBytes: 800,
      carrierControlReserveBytes: 320,
      routeHighWaterBytes: 8_192,
      routeLowWaterBytes: 4_096,
    },
  });
  const active = connect(h);
  acknowledgeAll(active.connection, active.transport);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId, {
    routeId: "occupying-route-a",
    routeFence: "occupying-fence-a",
  })));
  acknowledgeAll(active.connection, active.transport);
  active.connection.receive(wire(routeOpen(connectorId, {
    routeId: "healthy-route-b",
    routeFence: "healthy-fence-b",
  })));
  acknowledgeAll(active.connection, active.transport);
  const routeA = h.bound.find((binding) => binding.routeId === "occupying-route-a");
  const routeB = h.bound.find((binding) => binding.routeId === "healthy-route-b");
  active.transport.acceptFrame = (bytes) => {
    const frame = codec.decodeRelayV2WebSocketFrame("carrier", bytes).frame;
    return frame.type !== "route.data" || frame.routeId !== routeA.routeId;
  };

  let acceptedByA = 0;
  while (h.actor.sendPublic(routeA, publicV2Frame(`occupy-${acceptedByA}`))) {
    acceptedByA += 1;
    assert.ok(acceptedByA < 16);
  }
  assert.ok(acceptedByA > 0);
  assert.equal(h.actor.sendPublic(routeB, publicV2Frame("healthy-first-attempt")), false);
  assert.deepEqual(h.closing, []);

  now += 5_000;
  const pressureTimer = timers.findLast((timer) => !timer.cancelled);
  pressureTimer.callback();
  assert.deepEqual(h.closing.map((entry) => entry.binding.routeId), [routeA.routeId]);
  acknowledgeAll(active.connection, active.transport);
  assert.equal(h.actor.sendPublic(routeB, publicV2Frame("healthy-after-drain")), true);
  assert.equal(h.closing.some((entry) => entry.binding === routeB), false);
});

test("control, queued data, and socket-buffered bytes share one carrier hard limit", () => {
  assert.throws(
    () => createHarness({
      queueLimits: {
        carrierHighWaterBytes: 16 * 1_048_576 + 1,
      },
    }),
    /hard limit cannot exceed 16 MiB/,
  );

  const h = createHarness({
    queueLimits: {
      maxQueuedDataFramesPerRoute: 16,
      maxQueuedDataFrames: 16,
      maxQueuedControlFrames: 8,
      carrierHighWaterBytes: 1_600,
      carrierLowWaterBytes: 800,
      carrierControlReserveBytes: 320,
      routeHighWaterBytes: 8_192,
      routeLowWaterBytes: 4_096,
    },
  });
  h.credentials.add("credential-2", "2", "access-jti-2");
  const active = connect(h);
  const connectorId = register(active.connection, active.hello);
  active.connection.receive(wire(routeOpen(connectorId)));
  const binding = h.bound.at(-1);
  acknowledgeAll(active.connection, active.transport);

  let acceptedData = 0;
  while (h.actor.sendPublic(binding, publicV2Frame(`shared-${acceptedData}`))) {
    acceptedData += 1;
    assert.ok(acceptedData < 16);
  }
  assert.ok(acceptedData > 0);
  const dataBuffered = active.transport.bufferedAmount();
  assert.ok(dataBuffered <= 1_600 - 320);

  h.credentials.prepareResult = preparedReauthentication({
    requestId: "reauth-shared-limit",
  });
  assert.equal(
    h.actor.requestReauthentication("reauth-shared-limit", "credential-2"),
    true,
  );
  assert.equal(decoded(active.transport.sent).at(-1).type, "host.reauthenticate");
  assert.ok(active.transport.bufferedAmount() <= 1_600);
});
