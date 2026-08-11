import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const codec = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codec.js"
);

const contractRoot = new URL(
  "../contracts/relay/extensions/agent-transcript-lifecycle/v1/",
  import.meta.url,
);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

const manifest = readJson("manifest.json");

function hasCodecCode(error, expectedCode) {
  const failure = codec.relayAgentCodecFailure(error);
  return failure?.domain === codec.RELAY_AGENT_CODEC_ERROR_DOMAIN
    && failure.code === expectedCode;
}

test("Node Relay Agent extension codec consumes the frozen public wire corpus", () => {
  for (const fixture of readJson("golden-frames.json")) {
    const bytes = Buffer.from(fixture.wire, "utf8");
    const decoded = codec.decodeRelayAgentTranscriptLifecycleFrame(bytes, {
      opcode: "text",
      compressed: false,
    });
    assert.equal(decoded.normalized.channel, "public", fixture.name);
    assert.equal(decoded.normalized.version, 2, fixture.name);
    assert.equal(decoded.normalized.capability, manifest.capability, fixture.name);
    assert.equal(decoded.normalized.type, fixture.type, fixture.name);
    assert.equal(decoded.canonicalWire, fixture.wire, fixture.name);
    assert.deepEqual(
      Buffer.from(codec.encodeRelayAgentTranscriptLifecycleFrame(decoded.frame)),
      bytes,
      fixture.name,
    );
  }
});

test("Node Relay Agent extension codec rejects every frozen invalid vector and strict framing violation", () => {
  for (const fixture of readJson("invalid-frames.json")) {
    assert.throws(
      () => codec.decodeRelayAgentTranscriptLifecycleFrame(Buffer.from(fixture.wire)),
      (error) => hasCodecCode(error, fixture.expectedError),
      fixture.name,
    );
  }

  const golden = readJson("golden-frames.json")[0].wire;
  for (const [name, bytes, metadata, expectedCode] of [
    ["duplicate JSON key", Buffer.from(golden.replace('"payload":{}', '"payload":{},"payload":{}')), {}, "INVALID_ENVELOPE"],
    ["binary frame", Buffer.from(golden), { opcode: "binary" }, "INVALID_ENVELOPE"],
    ["compressed frame", Buffer.from(golden), { compressed: true }, "PROTOCOL_UNSUPPORTED"],
  ]) {
    assert.throws(
      () => codec.decodeRelayAgentTranscriptLifecycleFrame(bytes, metadata),
      (error) => hasCodecCode(error, expectedCode),
      name,
    );
  }
});
