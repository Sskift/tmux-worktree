import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const codec = await import(
  "../dist/relay/extensions/agentTranscriptLifecycle/v1/codec.js"
);

const contractRoot = new URL(
  "../contracts/relay/extensions/agent-transcript-lifecycle/v1/",
  import.meta.url,
);
const canonicalCounter = /^(0|[1-9][0-9]*)$/;
const credentialFieldNames = new Set([
  "accessToken",
  "refreshToken",
  "resumeToken",
  "enrollmentCode",
  "bootstrapToken",
]);
const credentialPrefixes = /twcap2\.|twref2\.|twenroll2\.|twhostboot2\./;

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

function assertUniqueNames(values, label) {
  const names = values.map((value) => value.name);
  assert.equal(new Set(names).size, names.length, `${label} names must be unique`);
  for (const name of names) assert.match(name, /\S/, `${label} name must not be empty`);
}

function inspectFixtureValue(value, label, checkShape = true) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectFixtureValue(item, `${label}[${index}]`, checkShape));
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (checkShape && value.recordType === "lifecycle") {
    assert.match(value.sourceEpoch, /\S/, `${label}.sourceEpoch must identify source lineage`);
  }
  for (const [key, child] of Object.entries(value)) {
    assert.equal(credentialFieldNames.has(key), false, `${label}.${key} leaks a credential field`);
    if (checkShape && key.endsWith("Id") && child !== null) {
      assert.equal(typeof child, "string", `${label}.${key} must be an opaque string`);
      assert.match(child, /\S/, `${label}.${key} must not be empty`);
    }
    if (checkShape && key.endsWith("Seq") && child !== null) {
      assert.equal(typeof child, "string", `${label}.${key} must be a string counter`);
      assert.match(child, canonicalCounter, `${label}.${key} must be canonical`);
    }
    inspectFixtureValue(child, `${label}.${key}`, checkShape);
  }
}

function assertNoCredentialMaterial(value, label, checkShape = true) {
  assert.doesNotMatch(JSON.stringify(value), credentialPrefixes, `${label} credential material`);
  inspectFixtureValue(value, label, checkShape);
}

function assertMachineStepShape(step, label, side) {
  assert.equal(typeof step.input, "object", `${label}.input`);
  assert.equal(typeof step.expect, "object", `${label}.expect`);
  assert.match(step.expect.disposition, /\S/, `${label}.expect.disposition`);
  assert.match(step.expect.lastAgentSeq ?? step.expect.agentEventSeq, canonicalCounter, `${label} expected sequence`);
  if (side === "authority") {
    assert.match(step.input.sourceEpoch, /\S/, `${label}.sourceEpoch`);
    assert.match(step.input.sourceEventId, /\S/, `${label}.sourceEventId`);
    assert.match(step.input.sourceSeq, canonicalCounter, `${label}.sourceSeq`);
    assert.match(step.input.mutation.mutationType, /\S/, `${label}.mutationType`);
  } else {
    assert.match(step.input.kind, /\S/, `${label}.input.kind`);
    if (step.input.kind === "agent_event") {
      assert.match(step.input.timelineEpoch, /\S/, `${label}.timelineEpoch`);
      assert.match(step.input.agentEventSeq, canonicalCounter, `${label}.agentEventSeq`);
      assert.match(step.input.eventId, /\S/, `${label}.eventId`);
    }
  }
}

function collectPublicEvents(frame) {
  if (frame.type === "agent.timeline.event") {
    return [
      {
        timelineEpoch: frame.payload.timelineEpoch,
        agentEventSeq: frame.payload.agentEventSeq,
        eventId: frame.payload.eventId,
      },
    ];
  }
  if (frame.type === "agent.timeline.replay.page") {
    return frame.payload.events.map((event) => ({
      timelineEpoch: frame.payload.timelineEpoch,
      agentEventSeq: event.agentEventSeq,
      eventId: event.eventId,
    }));
  }
  return [];
}

const manifest = readJson("manifest.json");

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
      (error) => error instanceof codec.RelayV2CodecError
        && error.code === fixture.expectedError,
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
      (error) => error instanceof codec.RelayV2CodecError && error.code === expectedCode,
      name,
    );
  }
});

test("Relay Agent extension v1 fixture set is internally complete and machine-readable", () => {
  assert.equal(manifest.contract, "tmux-worktree-relay-agent-transcript-lifecycle-extension");
  assert.equal(manifest.version, 1);
  assert.equal(
    manifest.status,
    "frozen-extension-unwired-node-durable-authority-codec-replay-and-android-reducer-foundations",
  );
  assert.equal(manifest.capability, "agent.transcript-lifecycle.v1");
  assert.deepEqual(manifest.delivery, {
    artifactKind: "fixtures-plus-unwired-node-durable-authority-codec-replay-and-android-reducer-foundations",
    runtimeConsumers: "pending",
    nodeCodecConformance: true,
    nodeDurableAuthorityStoreFoundation: true,
    nodeReplayRuntimeFoundation: true,
    nodeRuntimeIntegrated: false,
    androidCodecConformance: false,
    hostAuthorityMachineConformance: true,
    androidConsumerMachineConformance: false,
    androidLifecycleReducerFixtureConformance: true,
    androidReducerRuntimeIntegrated: false,
    g4Passed: false,
  });
  assert.equal(manifest.activation.baseRequiredCapability, false);
  assert.equal(manifest.activation.requiresBaseV2Gate, "G3");
  assert.equal(manifest.activation.releaseGate, "G4");
  assert.equal(manifest.activation.failureIsolation, "extension-only");
  assert.equal(manifest.boundaries.relayV1Unchanged, true);
  assert.equal(manifest.boundaries.relayV2BaseContractUnchanged, true);
  assert.equal(manifest.boundaries.productionCapabilityDelivered, false);
  assert.equal(manifest.boundaries.nodeHostRuntimeIntegrated, false);
  assert.equal(manifest.boundaries.nodeCapabilityAdvertised, false);
  assert.equal(manifest.boundaries.androidReducerFoundationOnly, true);
  assert.equal(manifest.boundaries.androidRoomIntegrated, false);
  assert.equal(manifest.boundaries.androidActorIntegrated, false);
  assert.equal(manifest.boundaries.androidUiIntegrated, false);
  assert.equal(manifest.boundaries.androidSystemNotificationIntegrated, false);
  assert.equal(manifest.notifications.offlinePushIncluded, false);
  assert.equal(manifest.identity.baseHostEventSeqUnchanged, true);
  assert.ok(existsSync(new URL(manifest.normativeDocument, contractRoot)));

  assertUniqueNames(manifest.files.map((file) => ({ name: file.path })), "manifest files");
  for (const file of manifest.files) {
    assert.ok(existsSync(new URL(file.path, contractRoot)), `${file.path} must exist`);
  }

  const golden = readJson("golden-frames.json");
  assertUniqueNames(golden, "golden frame");
  const goldenTypes = new Set();
  const publicEventIds = new Set();
  const publicSequenceKeys = new Set();
  for (const fixture of golden) {
    const frame = JSON.parse(fixture.wire);
    assert.equal(JSON.stringify(frame), fixture.wire, `${fixture.name} must be canonical JSON`);
    assert.equal(frame.protocolVersion, 2, `${fixture.name}.protocolVersion`);
    assert.equal(frame.type, fixture.type, `${fixture.name}.type`);
    assert.match(frame.kind, /^(request|response|event)$/);
    assert.match(fixture.direction, /^(client-to-host|host-to-client)$/);
    if (frame.type === "agent.timeline.status") {
      if (frame.payload.support === "available") {
        assert.match(frame.payload.activeSourceEpoch, /\S/, `${fixture.name}.activeSourceEpoch`);
      } else {
        assert.equal(frame.payload.activeSourceEpoch, null, `${fixture.name}.activeSourceEpoch`);
      }
    }
    goldenTypes.add(fixture.type);
    for (const event of collectPublicEvents(frame)) {
      const sequenceKey = `${event.timelineEpoch}:${event.agentEventSeq}`;
      assert.equal(publicEventIds.has(event.eventId), false, `duplicate public eventId ${event.eventId}`);
      assert.equal(publicSequenceKeys.has(sequenceKey), false, `duplicate public sequence ${sequenceKey}`);
      publicEventIds.add(event.eventId);
      publicSequenceKeys.add(sequenceKey);
    }
    assertNoCredentialMaterial(frame, `golden/${fixture.name}`);
  }
  assert.deepEqual([...goldenTypes].sort(), [...manifest.wire.messageTypes].sort());

  const invalid = readJson("invalid-frames.json");
  assertUniqueNames(invalid, "invalid frame");
  const invalidCategories = new Set();
  const declaredWireErrors = new Set(["INVALID_ENVELOPE", ...manifest.wire.extensionErrorCodes]);
  const machineDispositions = new Set([
    ...manifest.machineDispositions.authorityIngestion,
    ...manifest.machineDispositions.androidLocal,
  ]);
  for (const fixture of invalid) {
    const frame = JSON.parse(fixture.wire);
    assert.equal(JSON.stringify(frame), fixture.wire, `${fixture.name} must be canonical JSON`);
    assert.equal(frame.type, fixture.type, `${fixture.name}.type`);
    assert.match(fixture.expectedError, /\S/, `${fixture.name}.expectedError`);
    assert.ok(declaredWireErrors.has(fixture.expectedError), `${fixture.name} wire error is declared`);
    assert.equal(
      machineDispositions.has(fixture.expectedError),
      false,
      `${fixture.name} must not encode a machine disposition as a wire error`,
    );
    assert.match(fixture.category, /\S/, `${fixture.name}.category`);
    invalidCategories.add(fixture.category);
    assertNoCredentialMaterial(frame, `invalid/${fixture.name}`, false);
  }
  for (const category of manifest.requiredInvalidCategories) {
    assert.ok(invalidCategories.has(category), `missing invalid category ${category}`);
  }

  const scenarios = new Set();
  const authorityDispositions = new Set();
  const authorityCases = readJson("authority-machine-cases.json");
  assertUniqueNames(authorityCases, "authority case");
  for (const fixture of authorityCases) {
    assert.ok(fixture.steps.length > 0, `${fixture.name} must contain steps`);
    fixture.scenarios.forEach((scenario) => scenarios.add(scenario));
    const sourceEvents = new Map();
    fixture.steps.forEach((step, index) => {
      const label = `${fixture.name}[${index}]`;
      assertMachineStepShape(step, label, "authority");
      authorityDispositions.add(step.expect.disposition);
      if (step.arrange !== undefined) {
        assert.deepEqual(
          Object.keys(step.arrange),
          ["expireSourceDedupeEvidence"],
          `${label}.arrange must use its closed machine-fixture schema`,
        );
        assert.ok(step.arrange.expireSourceDedupeEvidence.length > 0, `${label}.arrange evidence`);
        for (const [arrangeIndex, key] of step.arrange.expireSourceDedupeEvidence.entries()) {
          assert.deepEqual(
            Object.keys(key).sort(),
            ["sourceEpoch", "sourceEventId"],
            `${label}.arrange[${arrangeIndex}]`,
          );
          assert.match(key.sourceEpoch, /\S/, `${label}.arrange[${arrangeIndex}].sourceEpoch`);
          assert.match(key.sourceEventId, /\S/, `${label}.arrange[${arrangeIndex}].sourceEventId`);
        }
      }
      const sourceKey = `${step.input.sourceEpoch}:${step.input.sourceEventId}`;
      if (sourceEvents.has(sourceKey)) {
        if (step.expect.disposition === "source_event_conflict") {
          assert.notDeepEqual(step.input, sourceEvents.get(sourceKey), `${label} conflict must differ`);
        } else {
          assert.deepEqual(step.input, sourceEvents.get(sourceKey), `${label} duplicate must be exact`);
        }
      } else {
        sourceEvents.set(sourceKey, step.input);
      }
      assertNoCredentialMaterial(step, `authority/${label}`);
    });
  }

  const clientDispositions = new Set();
  const notifications = new Set();
  const clientCases = readJson("client-machine-cases.json");
  assertUniqueNames(clientCases, "client case");
  for (const fixture of clientCases) {
    assert.ok(fixture.steps.length > 0, `${fixture.name} must contain steps`);
    assert.match(fixture.initial.lastAgentSeq, canonicalCounter, `${fixture.name}.initial.lastAgentSeq`);
    fixture.scenarios.forEach((scenario) => scenarios.add(scenario));
    fixture.steps.forEach((step, index) => {
      const label = `${fixture.name}[${index}]`;
      assertMachineStepShape(step, label, "client");
      clientDispositions.add(step.expect.disposition);
      if (step.expect.notification) notifications.add(step.expect.notification);
      assertNoCredentialMaterial(step, `client/${label}`);
    });
  }

  for (const scenario of manifest.requiredMachineScenarios) {
    assert.ok(scenarios.has(scenario), `missing machine scenario ${scenario}`);
  }
  assert.equal(manifest.machineDispositions.areWireErrorCodes, false);
  assert.deepEqual(
    [...authorityDispositions].sort(),
    [...manifest.machineDispositions.authorityIngestion].sort(),
    "authority fixture dispositions must equal the manifest closed set",
  );
  assert.deepEqual(
    [...clientDispositions].sort(),
    [...manifest.machineDispositions.androidLocal].sort(),
    "client fixture dispositions must equal the manifest closed set",
  );
  for (const outcome of [
    "none",
    "shown",
    "suppressed_permission",
    "suppressed_inactive_profile",
  ]) {
    assert.ok(notifications.has(outcome), `missing notification outcome ${outcome}`);
  }
});
