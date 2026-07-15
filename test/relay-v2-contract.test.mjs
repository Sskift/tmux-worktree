import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TextDecoder } from "node:util";

const contractRoot = new URL("../contracts/relay/v2/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

function byName(fixtures) {
  return new Map(fixtures.map((fixture) => [fixture.name, fixture]));
}

function valueAt(value, path) {
  return path.reduce((current, segment) => current[segment], value);
}

function materializeInput(input) {
  switch (input.kind) {
    case "utf8":
      return Buffer.from(input.wire, "utf8");
    case "base64":
      return Buffer.from(input.data, "base64");
    case "repeat-ascii":
      return Buffer.from(input.ascii.repeat(input.count), "ascii");
    case "nested-array":
      return Buffer.from(`${"[".repeat(input.depth)}0${"]".repeat(input.depth)}`);
    case "flat-object":
      return Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: input.keyCount }, (_, index) => [`k${index}`, index]),
          ),
        ),
      );
    default:
      assert.fail(`unknown fixture input kind ${input.kind}`);
  }
}

function parseUtf8Fixture(vector) {
  assert.equal(vector.input.kind, "utf8", vector.name);
  return JSON.parse(vector.input.wire);
}

function isCanonicalBase64(value) {
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) && Buffer.from(value, "base64").toString("base64") === value
  );
}

test("Relay v2 machine fixture integrity (not runtime codec conformance)", async (t) => {
  const manifest = readJson("manifest.json");
  const publicGolden = readJson("golden-public-handshake.json");
  const carrierGolden = readJson("golden-carrier.json");
  const invalid = readJson("invalid-vectors.json");
  const golden = [...publicGolden, ...carrierGolden];
  const goldenByName = byName(golden);

  await t.test("manifest keeps the future contract and pending consumers explicit", () => {
    assert.equal(manifest.contract, "tmux-worktree-relay-v2-base");
    assert.equal(manifest.contractVersion, "2.0.0-android-first");
    assert.equal(manifest.fixtureFormatVersion, 1);
    assert.equal(manifest.contractStatus, "frozen");
    assert.equal(manifest.implementationStatus, "not-implemented");
    assert.equal(manifest.conformanceStatus, "fixtures-only");
    assert.equal(
      manifest.runtimeCodecConsumptionStatus,
      "pending-node-and-android-owners",
    );
    assert.equal(manifest.capabilityAdvertisementAllowed, false);
    assert.equal(manifest.fixtureIntegrityIsRuntimeConformance, false);
    assert.deepEqual(manifest.intendedConsumers, [
      "node-relay-v2-codec",
      "android-relay-v2-codec",
    ]);
    assert.deepEqual(manifest.requiredCapabilities, [
      "error.structured.v1",
      "command.ledger.v1",
      "command.query.v1",
      "snapshot.revision.v1",
      "event.sequence.v1",
      "terminal.stream.resume.v1",
    ]);
    assert.deepEqual(
      manifest.files.map(({ role, channel, path }) => ({ role, channel, path })),
      [
        {
          role: "golden",
          channel: "public",
          path: "golden-public-handshake.json",
        },
        {
          role: "golden",
          channel: "carrier",
          path: "golden-carrier.json",
        },
        {
          role: "invalid",
          channel: "public-and-carrier",
          path: "invalid-vectors.json",
        },
      ],
    );
    assert.deepEqual(manifest.acceptancePending, [
      "node-production-codec-consumes-all-golden-and-invalid-vectors",
      "android-production-codec-consumes-all-golden-and-invalid-vectors",
      "node-and-android-normalized-results-match",
      "v1-fixtures-and-codecs-remain-unchanged",
    ]);
  });

  await t.test("golden handshake and carrier frames are exact closed examples", () => {
    assert.equal(goldenByName.size, golden.length, "golden fixture names must be unique");
    assert.ok(publicGolden.length > 0);
    assert.ok(carrierGolden.length > 0);

    for (const fixture of golden) {
      assert.equal(typeof fixture.name, "string", fixture.name);
      assert.ok(fixture.name.length > 0, "golden fixture name must not be empty");
      assert.equal(typeof fixture.direction, "string", fixture.name);
      assert.equal(typeof fixture.phase, "string", fixture.name);
      assert.equal(typeof fixture.type, "string", fixture.name);
      assert.equal(typeof fixture.wire, "string", fixture.name);
      const frame = JSON.parse(fixture.wire);
      assert.equal(JSON.stringify(frame), fixture.wire, `${fixture.name} exact wire`);
      assert.equal(frame.type, fixture.type, `${fixture.name} type`);
      if (publicGolden.includes(fixture)) {
        assert.equal(frame.protocolVersion, 2, fixture.name);
        assert.equal(Object.hasOwn(frame, "carrierVersion"), false, fixture.name);
      } else {
        assert.equal(frame.carrierVersion, 1, fixture.name);
        assert.equal(Object.hasOwn(frame, "protocolVersion"), false, fixture.name);
      }
    }

    const capabilities = manifest.requiredCapabilities;
    assert.deepEqual(
      JSON.parse(goldenByName.get("relay-welcome").wire).payload.capabilities,
      capabilities,
    );
    const clientHello = JSON.parse(goldenByName.get("client-hello-fresh").wire);
    assert.deepEqual(clientHello.payload.capabilities, capabilities);
    assert.deepEqual(clientHello.payload.requiredCapabilities, capabilities);
    assert.equal(clientHello.payload.resume, null);
    const hostWelcome = JSON.parse(
      goldenByName.get("host-welcome-snapshot-required").wire,
    );
    assert.deepEqual(hostWelcome.payload.capabilities, capabilities);
    assert.equal(hostWelcome.payload.resumeDisposition, "snapshot_required");
    assert.equal(hostWelcome.payload.resumeReason, "fresh");
    assert.deepEqual(
      JSON.parse(goldenByName.get("host-hello").wire).payload.capabilities,
      capabilities,
    );

    for (const name of [
      "relay-unavailable-host-offline",
      "client-hello-cursor-ahead-error",
      "carrier-error-host-reauthenticate",
    ]) {
      const frame = JSON.parse(goldenByName.get(name).wire);
      const error = frame.type === "relay.unavailable" ? frame.payload.error : frame.error;
      assert.ok(manifest.errorCodes.includes(error.code), `${name} error code`);
      assert.ok(
        manifest.commandDispositions.includes(error.commandDisposition),
        `${name} command disposition`,
      );
    }

    const routeData = JSON.parse(
      goldenByName.get("route-data-client-to-host").wire,
    );
    assert.match(routeData.seq, /^(?:0|[1-9][0-9]*)$/);
    assert.equal(isCanonicalBase64(routeData.payload.data), true);
    assert.equal(
      Buffer.from(routeData.payload.data, "base64").toString("utf8"),
      '{"protocolVersion":2}',
    );
  });

  await t.test("invalid vectors contain their declared byte or field defect", () => {
    assert.equal(byName(invalid).size, invalid.length, "invalid names must be unique");
    const validClientHello = JSON.parse(goldenByName.get("client-hello-fresh").wire);
    const validRouteData = JSON.parse(
      goldenByName.get("route-data-client-to-host").wire,
    );

    for (const vector of invalid) {
      assert.equal(vector.expected.outcome, "reject", vector.name);
      assert.ok(manifest.errorCodes.includes(vector.expected.errorCode), vector.name);
      assert.equal(vector.expected.errorCode, "INVALID_ENVELOPE", vector.name);
      assert.equal(vector.category, vector.expected.failureClass, vector.name);
      assert.ok(Object.hasOwn(manifest.fixtureInputKinds, vector.input.kind), vector.name);

      switch (vector.integrity.kind) {
        case "duplicate-json-member": {
          const token = `${JSON.stringify(vector.integrity.member)}:`;
          assert.equal(
            vector.input.wire.split(token).length - 1,
            vector.integrity.occurrences,
            vector.name,
          );
          break;
        }
        case "member-present": {
          const frame = parseUtf8Fixture(vector);
          assert.deepEqual(
            valueAt(frame, vector.integrity.path),
            vector.integrity.value,
            vector.name,
          );
          if (vector.category === "unknown-field") {
            assert.equal(
              Object.hasOwn(validClientHello.payload, "principalId"),
              false,
              vector.name,
            );
          }
          if (vector.category === "forbidden-null") {
            assert.equal(typeof validClientHello.requestId, "string", vector.name);
          }
          break;
        }
        case "member-type": {
          const frame = parseUtf8Fixture(vector);
          assert.equal(
            typeof valueAt(frame, vector.integrity.path),
            vector.integrity.type,
            vector.name,
          );
          assert.equal(typeof validClientHello.protocolVersion, "number", vector.name);
          break;
        }
        case "non-canonical-counter": {
          const value = valueAt(parseUtf8Fixture(vector), vector.integrity.path);
          assert.equal(value, vector.integrity.value, vector.name);
          assert.doesNotMatch(value, /^(?:0|[1-9][0-9]*)$/, vector.name);
          assert.match(validRouteData.seq, /^(?:0|[1-9][0-9]*)$/);
          break;
        }
        case "counter-overflow": {
          const value = valueAt(parseUtf8Fixture(vector), vector.integrity.path);
          assert.equal(value, vector.integrity.value, vector.name);
          assert.ok(BigInt(value) > BigInt(manifest.limits.unsignedCounterMax), vector.name);
          break;
        }
        case "non-canonical-base64": {
          const value = valueAt(parseUtf8Fixture(vector), vector.integrity.path);
          assert.equal(value, vector.integrity.value, vector.name);
          assert.equal(isCanonicalBase64(value), false, vector.name);
          assert.equal(isCanonicalBase64(validRouteData.payload.data), true);
          break;
        }
        case "invalid-utf8": {
          const bytes = materializeInput(vector.input);
          assert.equal(Buffer.from(bytes.toString("base64"), "base64").equals(bytes), true);
          assert.throws(
            () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            vector.name,
          );
          break;
        }
        case "byte-length-over-limit": {
          assert.equal(vector.integrity.limit, manifest.limits.publicFrameBytes);
          assert.equal(materializeInput(vector.input).length, vector.integrity.limit + 1);
          break;
        }
        case "depth-over-limit": {
          assert.equal(vector.integrity.limit, manifest.limits.jsonMaxDepth);
          assert.equal(vector.input.depth, vector.integrity.limit + 1);
          let nested = JSON.parse(materializeInput(vector.input).toString("utf8"));
          for (let depth = 0; depth < vector.input.depth; depth += 1) {
            assert.equal(nested.length, 1, vector.name);
            nested = nested[0];
          }
          assert.equal(nested, 0, vector.name);
          break;
        }
        case "direct-key-count-over-limit": {
          assert.equal(
            vector.integrity.limit,
            manifest.limits.jsonMaxDirectKeysPerObject,
          );
          const frame = JSON.parse(materializeInput(vector.input).toString("utf8"));
          assert.equal(Object.keys(frame).length, vector.integrity.limit + 1);
          break;
        }
        case "utf8-byte-length-over-limit": {
          assert.equal(vector.integrity.limit, manifest.limits.idMaxUtf8Bytes);
          const value = valueAt(parseUtf8Fixture(vector), vector.integrity.path);
          assert.equal(Buffer.byteLength(value, "utf8"), vector.integrity.limit + 1);
          break;
        }
        case "unsafe-integer": {
          const value = valueAt(parseUtf8Fixture(vector), vector.integrity.path);
          assert.equal(Number.isSafeInteger(value), false, vector.name);
          assert.ok(value > manifest.limits.jsonSafeIntegerMax, vector.name);
          break;
        }
        default:
          assert.fail(`unknown fixture integrity kind ${vector.integrity.kind}`);
      }
    }
  });
});
