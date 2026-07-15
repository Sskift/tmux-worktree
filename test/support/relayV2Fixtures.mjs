import { readFileSync } from "node:fs";

const contractRoot = new URL("../../contracts/relay/v2/", import.meta.url);

export function readRelayV2ContractJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

export function loadRelayV2FixtureCorpus() {
  const manifest = readRelayV2ContractJson("manifest.json");
  const golden = manifest.files
    .filter(({ role }) => role === "golden")
    .flatMap(({ path }) => readRelayV2ContractJson(path));
  const rawByName = new Map(golden.map((fixture) => [fixture.name, fixture]));
  const frameByName = new Map();

  function materializeGolden(name, stack = new Set()) {
    if (frameByName.has(name)) return structuredClone(frameByName.get(name));
    const fixture = rawByName.get(name);
    if (!fixture) throw new Error("unknown Relay v2 golden fixture " + name);
    if (stack.has(name)) throw new Error("cyclic Relay v2 golden fixture " + name);
    stack.add(name);
    const frame = fixture.frame !== undefined
      ? structuredClone(fixture.frame)
      : materializeGolden(fixture.deriveFrom, stack);
    for (const [path, value] of Object.entries(fixture.set ?? {})) {
      setJsonPointer(frame, path, structuredClone(value));
    }
    stack.delete(name);
    frameByName.set(name, frame);
    return structuredClone(frame);
  }

  const materializedGolden = golden.map((fixture) => ({
    ...fixture,
    frame: materializeGolden(fixture.name),
  }));
  return {
    manifest,
    golden: materializedGolden,
    goldenByName: new Map(materializedGolden.map((fixture) => [fixture.name, fixture])),
    invalid: readRelayV2ContractJson("invalid-vectors.json"),
    dialect: readRelayV2ContractJson("dialect-outcomes.json"),
  };
}

function pointerSegments(pointer) {
  if (!pointer.startsWith("/")) throw new Error("invalid JSON pointer " + pointer);
  return pointer.slice(1).split("/").map((segment) => (
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
}

export function setJsonPointer(root, pointer, value) {
  const segments = pointerSegments(pointer);
  let target = root;
  for (const segment of segments.slice(0, -1)) {
    target = target[segment];
    if (target === null || typeof target !== "object") {
      throw new Error("JSON pointer does not address an object: " + pointer);
    }
  }
  target[segments.at(-1)] = value;
}

function bytesForGeneratedInput(input) {
  switch (input.kind) {
    case "utf8":
      return Buffer.from(input.wire, "utf8");
    case "base64":
      return Buffer.from(input.data, "base64");
    case "repeat-ascii":
      return Buffer.from(input.ascii.repeat(input.count), "ascii");
    case "nested-array":
      return Buffer.from("[".repeat(input.depth) + "0" + "]".repeat(input.depth));
    case "flat-object":
      return Buffer.from(JSON.stringify(Object.fromEntries(
        Array.from({ length: input.keyCount }, (_, index) => ["k" + index, index]),
      )));
    case "key-grid":
      return Buffer.from(JSON.stringify(Object.fromEntries(
        Array.from({ length: input.objectCount }, (_, objectIndex) => [
          "o" + objectIndex,
          Object.fromEntries(
            Array.from({ length: input.keysPerObject }, (_, keyIndex) => [
              "k" + keyIndex,
              keyIndex,
            ]),
          ),
        ]),
      )));
    case "flat-array":
      return Buffer.from(JSON.stringify(Array.from(
        { length: input.itemCount },
        (_, index) => index,
      )));
    case "state-key-grid":
      return Buffer.from(JSON.stringify({
        protocolVersion: 2,
        kind: "response",
        type: "state.snapshot.chunk",
        payload: {
          records: Array.from({ length: input.objectCount }, (_, objectIndex) => (
            Object.fromEntries(
              Array.from({ length: input.keysPerObject }, (_, keyIndex) => [
                "k" + objectIndex + "_" + keyIndex,
                keyIndex,
              ]),
            )
          )),
        },
      }));
    case "state-node-array":
      return Buffer.from(JSON.stringify({
        protocolVersion: 2,
        kind: "response",
        type: "state.snapshot.chunk",
        payload: {
          records: Array.from({ length: input.itemCount }, () => 0),
        },
      }));
    default:
      return null;
  }
}

function serializeGoldenMutation(input, goldenByName) {
  const fixture = goldenByName.get(input.fixture);
  if (!fixture) throw new Error("unknown Relay v2 golden fixture " + input.fixture);
  const frame = structuredClone(fixture.frame);
  switch (input.kind) {
    case "golden":
      break;
    case "golden-set":
      setJsonPointer(frame, input.path, structuredClone(input.value));
      break;
    case "golden-repeat-array": {
      const segments = pointerSegments(input.path);
      let target = frame;
      for (const segment of segments.slice(0, -1)) target = target[segment];
      const source = target[segments.at(-1)];
      if (!Array.isArray(source) || source.length === 0) {
        throw new Error(input.path + " is not a non-empty array");
      }
      target[segments.at(-1)] = Array.from(
        { length: input.count },
        () => structuredClone(source[0]),
      );
      break;
    }
    case "golden-base64-bytes":
      setJsonPointer(frame, input.path, Buffer.alloc(input.byteCount).toString("base64"));
      break;
    default:
      throw new Error("unsupported golden mutation " + input.kind);
  }
  return {
    bytes: Buffer.from(JSON.stringify(frame)),
    channel: fixture.channel,
    schema: fixture.schema ?? null,
    metadata: {
      opcode: input.opcode,
      compressed: input.compressed,
      contentEncoding: input.contentEncoding,
    },
  };
}

export function materializeRelayV2InvalidCases(corpus) {
  const cases = [];
  for (const vector of corpus.invalid) {
    if (vector.input.kind === "all-golden-add-field") {
      for (const fixture of corpus.golden) {
        const frame = structuredClone(fixture.frame);
        setJsonPointer(frame, vector.input.path, structuredClone(vector.input.value));
        cases.push(invalidCase(vector, fixture, frame));
      }
      continue;
    }
    if (vector.input.kind === "all-golden-payload-add-field") {
      for (const fixture of corpus.golden.filter((item) => (
        item.channel !== "https"
        && item.frame.payload !== null
        && typeof item.frame.payload === "object"
        && !Array.isArray(item.frame.payload)
      ))) {
        const frame = structuredClone(fixture.frame);
        setJsonPointer(frame, vector.input.path, structuredClone(vector.input.value));
        cases.push(invalidCase(vector, fixture, frame));
      }
      continue;
    }
    const generated = bytesForGeneratedInput(vector.input);
    if (generated !== null) {
      cases.push({
        name: vector.name,
        channel: vector.channel,
        schema: vector.schema ?? null,
        bytes: generated,
        metadata: {},
        expected: vector.expected,
      });
      continue;
    }
    const mutation = serializeGoldenMutation(vector.input, corpus.goldenByName);
    cases.push({
      name: vector.name,
      ...mutation,
      channel: vector.channel === "all" ? mutation.channel : vector.channel,
      schema: vector.schema ?? mutation.schema,
      expected: vector.expected,
    });
  }
  return cases;
}

function invalidCase(vector, fixture, frame) {
  return {
    name: vector.name + ":" + fixture.name,
    channel: fixture.channel,
    schema: fixture.schema ?? null,
    bytes: Buffer.from(JSON.stringify(frame)),
    metadata: {},
    expected: vector.expected,
  };
}
