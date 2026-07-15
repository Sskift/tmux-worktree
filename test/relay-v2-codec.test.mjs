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

test("Node Relay v2 dialect resolution matches the shared no-fallback matrix", () => {
  for (const fixture of corpus.dialect) {
    assert.deepEqual(
      codec.resolveRelayV2RouteDialect(fixture.input),
      fixture.expected,
      fixture.name,
    );
  }
});
