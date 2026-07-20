import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRelayV2FixtureCorpus,
  materializeRelayV2InvalidCases,
} from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
const codecReadiness = await import(
  "../dist/relay/v2/hostCodecReadinessActivation.js"
);
const corpus = loadRelayV2FixtureCorpus();

function decodeGolden(fixture, bytes) {
  return fixture.channel === "https"
    ? codec.decodeRelayV2HttpsBody(fixture.schema, bytes)
    : codec.decodeRelayV2WebSocketFrame(fixture.channel, bytes);
}

function encodeGolden(fixture, frame) {
  return fixture.channel === "https"
    ? codec.encodeRelayV2HttpsBody(fixture.schema, frame)
    : codec.encodeRelayV2WebSocketFrame(fixture.channel, frame);
}

test("Node Relay v2 production codec consumes every shared golden fixture", () => {
  for (const fixture of corpus.golden) {
    const wire = JSON.stringify(fixture.frame);
    const bytes = Buffer.from(wire, "utf8");
    const decoded = decodeGolden(fixture, bytes);
    assert.deepEqual(decoded.normalized, fixture.normalized, fixture.name);
    assert.equal(decoded.canonicalWire, wire, fixture.name);
    assert.deepEqual(
      Buffer.from(encodeGolden(fixture, decoded.frame)),
      bytes,
      fixture.name,
    );
  }
});

test("Node Relay v2 production codec rejects every shared invalid vector", () => {
  for (const vector of materializeRelayV2InvalidCases(corpus)) {
    assert.throws(
      () => {
        if (vector.channel === "https") {
          codec.decodeRelayV2HttpsBody(
            vector.schema,
            vector.bytes,
            vector.metadata.contentEncoding ?? null,
          );
        } else {
          codec.decodeRelayV2WebSocketFrame(vector.channel, vector.bytes, {
            opcode: vector.metadata.opcode,
            compressed: vector.metadata.compressed,
          });
        }
      },
      (error) => {
        assert.ok(error instanceof codec.RelayV2CodecError, vector.name);
        assert.equal(error.code, vector.expected.errorCode, vector.name);
        assert.equal(error.failureClass, vector.expected.failureClass, vector.name);
        return true;
      },
      vector.name,
    );
  }
});

test("host codec readiness owns one fixed production generation and exposes only close", () => {
  let observed = null;
  let closeCalls = 0;
  const lifecycle = codecReadiness.createRelayV2HostCodecReadinessActivation({
    readinessSink: {
      apply(snapshot) {
        observed = structuredClone(snapshot);
        return true;
      },
      close() { closeCalls += 1; },
    },
  });

  assert.notEqual(lifecycle, null);
  assert.deepEqual(observed, {
    source: "codec",
    generation: "1",
    ready: true,
  });
  assert.equal(Object.isFrozen(lifecycle), true);
  assert.deepEqual(Object.keys(lifecycle), ["close"]);
  assert.equal(lifecycle.apply, undefined);
  assert.equal(lifecycle.activate, undefined);
  assert.equal(lifecycle.issuer, undefined);
  assert.equal(lifecycle.receipt, undefined);
  lifecycle.close();
  lifecycle.close();
  assert.equal(closeCalls, 1);
});

test("host codec readiness rejects non-literal success, injection, and reentry", async () => {
  for (const conclusion of [false, Object.freeze({}), Promise.resolve(true)]) {
    let closeCalls = 0;
    const lifecycle = codecReadiness.createRelayV2HostCodecReadinessActivation({
      readinessSink: {
        apply() { return conclusion; },
        close() { closeCalls += 1; },
      },
    });
    assert.equal(lifecycle, null);
    assert.equal(closeCalls, 1);
  }

  let injectedApplyCalls = 0;
  const injected = codecReadiness.createRelayV2HostCodecReadinessActivation({
    readinessSink: {
      apply() { injectedApplyCalls += 1; return true; },
      close() {},
    },
    codec: { ready: true },
    hostRuntime: { ready: true },
    ready: true,
  });
  assert.equal(injected, null);
  assert.equal(injectedApplyCalls, 0);

  let outerCloseCalls = 0;
  let nestedCloseCalls = 0;
  let nested = undefined;
  const outer = codecReadiness.createRelayV2HostCodecReadinessActivation({
    readinessSink: {
      apply() {
        nested = codecReadiness.createRelayV2HostCodecReadinessActivation({
          readinessSink: {
            apply() { return true; },
            close() { nestedCloseCalls += 1; },
          },
        });
        return true;
      },
      close() { outerCloseCalls += 1; },
    },
  });
  assert.equal(nested, null);
  assert.equal(outer, null);
  assert.equal(nestedCloseCalls, 1);
  assert.equal(outerCloseCalls, 1);
});

test("Node Relay v2 route-envelope decoder defers command arguments until after authorization", () => {
  const frame = structuredClone(corpus.goldenByName.get("command-execute-create-terminal").frame);
  frame.payload.arguments.cwd = " /repo/demo";
  const bytes = Buffer.from(JSON.stringify(frame));
  const routed = codec.decodeRelayV2CommandRouteEnvelope(bytes);
  assert.equal(routed.envelope.type, "command.execute");
  assert.equal(routed.envelope.hostId, frame.hostId);
  assert.throws(
    () => codec.decodeRelayV2WebSocketFrame("public", bytes),
    (error) => error instanceof codec.RelayV2CodecError
      && error.failureClass === "invalid-argument",
  );
});

test("shared terminal ACK goldens preserve cumulative sequence baseline zero", () => {
  for (const [fixtureName, field] of [
    ["terminal-input-ack", "ackedThroughInputSeq"],
    ["terminal-resize-ack", "ackedThroughResizeSeq"],
  ]) {
    const frame = corpus.goldenByName.get(fixtureName).frame;
    assert.equal(frame.payload[field], "0");
    assert.doesNotThrow(() => codec.encodeRelayV2WebSocketFrame("public", frame));
  }
});

test("explicit client_closed remains a correlated response, never a natural event", () => {
  const event = structuredClone(corpus.goldenByName.get("terminal-closed-event").frame);
  event.payload.reason = "client_closed";
  event.payload.exitCode = null;
  assert.throws(
    () => codec.encodeRelayV2WebSocketFrame("public", event),
    (error) => error instanceof codec.RelayV2CodecError
      && error.failureClass === "schema-mismatch",
  );

  const response = structuredClone(corpus.goldenByName.get("terminal-closed-response").frame);
  response.payload.reason = "client_closed";
  response.payload.exitCode = null;
  assert.doesNotThrow(() => codec.encodeRelayV2WebSocketFrame("public", response));
});

test("Node Relay v2 dialect resolution matches the shared no-fallback matrix", () => {
  for (const fixture of corpus.dialect) {
    assert.deepEqual(
      codec.resolveRelayV2RouteDialect(fixture.input),
      fixture.expected,
      fixture.name,
    );
  }
});

test("carrier.error uses the broker-exact correlated schema", () => {
  const frame = {
    carrierVersion: 1,
    type: "carrier.error",
    requestId: "host-hello-request",
    connectorId: null,
    payload: { failedType: "host.hello" },
    error: {
      code: "DUPLICATE_CONNECTOR",
      message: "Duplicate connector",
      retryable: false,
      retryAfterMs: null,
      commandDisposition: "not_applicable",
      details: null,
    },
  };
  assert.doesNotThrow(() => codec.encodeRelayV2WebSocketFrame("carrier", frame));

  for (const invalid of [
    { ...frame, connectorId: "not-null" },
    { ...frame, routeId: "extra-route" },
    { ...frame, routeFence: "extra-fence" },
    {
      ...frame,
      connectorId: null,
      payload: { failedType: "host.reauthenticate" },
    },
  ]) {
    assert.throws(
      () => codec.encodeRelayV2WebSocketFrame("carrier", invalid),
      (error) => error instanceof codec.RelayV2CodecError,
    );
  }
});

test("negotiated frame limits are positive and internally consistent", () => {
  const golden = (name) => structuredClone(
    corpus.golden.find((fixture) => fixture.name === name).frame,
  );
  const rejectCarrier = (frame) => assert.throws(
    () => codec.encodeRelayV2WebSocketFrame("carrier", frame),
    (error) => error instanceof codec.RelayV2CodecError
      && error.code === "INVALID_ENVELOPE"
      && error.failureClass === "invalid-argument",
  );
  const helloZero = golden("host-hello");
  helloZero.payload.limits.maxFrameBytes = 0;
  rejectCarrier(helloZero);

  const helloContradiction = golden("host-hello");
  helloContradiction.payload.limits.maxFrameBytes = 32_768;
  helloContradiction.payload.limits.terminalMaxFrameBytes = 65_536;
  rejectCarrier(helloContradiction);

  const routeOpenZero = golden("route-open");
  routeOpenZero.payload.limits.maxFrameBytes = 0;
  rejectCarrier(routeOpenZero);

  const routeOpenedZero = golden("route-opened");
  routeOpenedZero.payload.maxFrameBytes = 0;
  rejectCarrier(routeOpenedZero);

  const relayWelcomeZero = golden("relay-welcome");
  relayWelcomeZero.payload.limits.maxFrameBytes = 0;
  assert.throws(
    () => codec.encodeRelayV2WebSocketFrame("public", relayWelcomeZero),
    (error) => error instanceof codec.RelayV2CodecError
      && error.code === "INVALID_ENVELOPE"
      && error.failureClass === "invalid-argument",
  );
});
