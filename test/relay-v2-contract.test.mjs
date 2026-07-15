import assert from "node:assert/strict";
import test from "node:test";
import {
  loadRelayV2FixtureCorpus,
  materializeRelayV2InvalidCases,
} from "./support/relayV2Fixtures.mjs";

const corpus = loadRelayV2FixtureCorpus();

test("Relay v2 base fixture manifest describes codec-only conformance without enabling runtime capability", () => {
  const { manifest } = corpus;
  assert.equal(manifest.contract, "tmux-worktree-relay-v2-base");
  assert.equal(manifest.contractVersion, "2.0.0-android-first");
  assert.equal(manifest.fixtureFormatVersion, 2);
  assert.equal(manifest.contractStatus, "frozen");
  assert.equal(manifest.implementationScope, "codec-and-conformance-only");
  assert.equal(manifest.conformanceStatus, "shared-node-android-runtime-codecs");
  assert.equal(manifest.capabilityAdvertisementAllowed, false);
  assert.deepEqual(manifest.runtimeConsumers, [
    "node-relay-v2-codec",
    "android-relay-v2-codec",
  ]);
  assert.deepEqual(manifest.normalizedShapes.public, [
    "channel",
    "version",
    "kind",
    "type",
    "requestId",
  ]);
  assert.deepEqual(manifest.normalizedShapes.carrier, [
    "channel",
    "version",
    "type",
    "requestId",
  ]);
  assert.deepEqual(manifest.normalizedShapes.https, ["channel", "schema"]);
  assert.ok(manifest.coverage.includes("terminal-open-replay-input-resize-close"));
  assert.ok(manifest.coverage.includes("command-execute-status-result-and-query"));
  assert.ok(manifest.coverage.includes("https-enrollment-refresh-bootstrap-and-revoke"));
  assert.ok(manifest.coverage.includes("v1-v2-dialect-outcomes-without-fallback"));
});

test("every Relay v2 golden fixture materializes to an exact channel-specific normalized result", () => {
  assert.ok(corpus.golden.length > 0);
  assert.equal(
    new Set(corpus.golden.map(({ name }) => name)).size,
    corpus.golden.length,
  );

  for (const fixture of corpus.golden) {
    assert.ok(fixture.name.length > 0, fixture.name);
    assert.equal(typeof fixture.frame, "object", fixture.name);
    assert.ok(fixture.frame !== null && !Array.isArray(fixture.frame), fixture.name);
    assert.equal(JSON.parse(JSON.stringify(fixture.frame)) !== null, true, fixture.name);
    if (fixture.channel === "public") {
      assert.deepEqual(fixture.normalized, {
        channel: "public",
        version: 2,
        kind: fixture.frame.kind,
        type: fixture.frame.type,
        requestId: fixture.frame.requestId ?? null,
      }, fixture.name);
      assert.equal(fixture.frame.protocolVersion, 2, fixture.name);
      assert.equal(fixture.type, fixture.frame.type, fixture.name);
    } else if (fixture.channel === "carrier") {
      assert.deepEqual(fixture.normalized, {
        channel: "carrier",
        version: 1,
        type: fixture.frame.type,
        requestId: fixture.frame.requestId ?? null,
      }, fixture.name);
      assert.equal(fixture.frame.carrierVersion, 1, fixture.name);
      assert.equal(fixture.type, fixture.frame.type, fixture.name);
    } else {
      assert.equal(fixture.channel, "https", fixture.name);
      assert.deepEqual(fixture.normalized, {
        channel: "https",
        schema: fixture.schema,
      }, fixture.name);
      assert.ok(corpus.manifest.httpsSchemas.includes(fixture.schema), fixture.name);
    }
  }
});

test("Relay v2 invalid vectors are executable and declare exact codec failures", () => {
  const materialized = materializeRelayV2InvalidCases(corpus);
  assert.ok(materialized.length >= corpus.invalid.length);
  assert.equal(
    new Set(corpus.invalid.map(({ name }) => name)).size,
    corpus.invalid.length,
  );
  for (const vector of corpus.invalid) {
    assert.ok(Object.hasOwn(corpus.manifest.fixtureInputKinds, vector.input.kind), vector.name);
    assert.equal(vector.expected.outcome, "reject", vector.name);
    assert.ok(
      ["INVALID_ENVELOPE", "PROTOCOL_UNSUPPORTED"].includes(vector.expected.errorCode),
      vector.name,
    );
    assert.equal(typeof vector.expected.failureClass, "string", vector.name);
    assert.ok(vector.expected.failureClass.length > 0, vector.name);
  }
  for (const item of materialized) {
    assert.ok(item.bytes instanceof Uint8Array, item.name);
    assert.ok(item.bytes.byteLength > 0, item.name);
    assert.ok(["public", "carrier", "https"].includes(item.channel), item.name);
  }
});

test("Relay v2 dialect matrix never translates or falls back", () => {
  assert.ok(corpus.dialect.length > 0);
  assert.equal(
    new Set(corpus.dialect.map(({ name }) => name)).size,
    corpus.dialect.length,
  );
  for (const fixture of corpus.dialect) {
    assert.equal(fixture.expected.fallback, false, fixture.name);
    if (fixture.expected.outcome === "accept") {
      assert.equal(fixture.expected.translation, false, fixture.name);
      assert.equal(
        fixture.expected.selectedDialect,
        fixture.input.clientDialect,
        fixture.name,
      );
    } else {
      assert.ok(
        ["HOST_DIALECT_UNAVAILABLE", "CAPABILITY_UNAVAILABLE"].includes(
          fixture.expected.errorCode,
        ),
        fixture.name,
      );
    }
  }
});
