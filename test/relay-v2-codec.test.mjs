import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRelayV2FixtureCorpus,
  materializeRelayV2InvalidCases,
} from "./support/relayV2Fixtures.mjs";

const codec = await import("../dist/relay/v2/codec.js");
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
