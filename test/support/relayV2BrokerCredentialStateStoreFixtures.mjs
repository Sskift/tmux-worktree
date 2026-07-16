import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const contractRoot = new URL(
  "../../contracts/relay/v2/broker-credential-state-store-v1/",
  import.meta.url,
);

const OBJECT_NAMES = ["header0", "header1", "payload0", "payload1"];
const HEADER_BYTES = 128;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAGIC = Buffer.from("TWV2BCS1", "ascii");

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, contractRoot), "utf8"));
}

function decodeBase64(value, label) {
  if (typeof value !== "string") throw new Error(`${label} is not Base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical Base64`);
  return bytes;
}

function decodeObjects(objects) {
  return Object.fromEntries(Object.entries(objects).map(([name, value]) => [
    name,
    value === null ? null : decodeBase64(value, name),
  ]));
}

function cloneObjects(objects) {
  return Object.fromEntries(Object.entries(objects).map(([name, value]) => [
    name,
    value === null ? null : Buffer.from(value),
  ]));
}

export function loadRelayV2BrokerCredentialStateStoreCorpus() {
  const manifest = readJson("manifest.json");
  const goldenFile = readJson("golden-binary.json");
  const golden = goldenFile.cases.map((fixture) => ({
    ...fixture,
    objects: decodeObjects(fixture.objects),
  }));
  return {
    manifest,
    golden,
    goldenByName: new Map(golden.map((fixture) => [fixture.name, fixture])),
    corrupt: readJson("corrupt-binary.json").vectors,
    nativeInterface: readJson("native-interface-cases.json"),
  };
}

function applyMutation(objects, mutation) {
  const current = objects[mutation.object];
  switch (mutation.kind) {
    case "write-byte":
      if (!Buffer.isBuffer(current)) throw new Error("mutation target is absent");
      current.writeUInt8(mutation.value, mutation.offset);
      return;
    case "write-u16-le":
      if (!Buffer.isBuffer(current)) throw new Error("mutation target is absent");
      current.writeUInt16LE(mutation.value, mutation.offset);
      return;
    case "write-u64-le":
      if (!Buffer.isBuffer(current)) throw new Error("mutation target is absent");
      current.writeBigUInt64LE(BigInt(mutation.value), mutation.offset);
      return;
    case "truncate":
      if (!Buffer.isBuffer(current)) throw new Error("mutation target is absent");
      objects[mutation.object] = current.subarray(0, mutation.length);
      return;
    case "xor-byte":
      if (!Buffer.isBuffer(current)) throw new Error("mutation target is absent");
      current[mutation.offset] ^= mutation.value;
      return;
    case "remove-object":
      if (!Object.hasOwn(objects, mutation.object)) throw new Error("unknown mutation object");
      objects[mutation.object] = null;
      return;
    case "add-object":
      objects[mutation.object] = decodeBase64(mutation.base64, mutation.object);
      return;
    case "recompute-header-checksum":
      if (!Buffer.isBuffer(current) || current.byteLength !== HEADER_BYTES) {
        throw new Error("header checksum target is invalid");
      }
      createHash("sha256").update(current.subarray(0, 96)).digest().copy(current, 96);
      return;
    default:
      throw new Error(`unknown broker credential fixture mutation ${mutation.kind}`);
  }
}

export function materializeRelayV2BrokerCredentialCorruptCases(corpus) {
  return corpus.corrupt.map((vector) => {
    const source = corpus.goldenByName.get(vector.deriveFrom);
    if (!source) throw new Error(`unknown broker credential fixture ${vector.deriveFrom}`);
    const objects = cloneObjects(source.objects);
    for (const mutation of vector.mutations) applyMutation(objects, mutation);
    return { ...vector, objects };
  });
}

class ContractFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new ContractFailure(code);
}

function parseHeader(bytes, expectedSlot) {
  if (bytes === null) return null;
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== HEADER_BYTES) reject("STORE_CORRUPT");
  const checksum = createHash("sha256").update(bytes.subarray(0, 96)).digest();
  if (!checksum.equals(bytes.subarray(96, 128))) reject("STORE_CORRUPT");
  if (!bytes.subarray(0, 8).equals(MAGIC)) reject("STORE_FORMAT_UNSUPPORTED");
  if (bytes.readUInt16LE(8) !== 1 || bytes.readUInt8(11) !== 0) {
    reject("STORE_FORMAT_UNSUPPORTED");
  }
  if (
    bytes.readUInt8(10) !== expectedSlot
    || bytes.readUInt32LE(12) !== HEADER_BYTES
    || bytes.subarray(64, 96).some((value) => value !== 0)
  ) reject("STORE_CORRUPT");
  const generation = bytes.readBigUInt64LE(16);
  const payloadLength = bytes.readBigUInt64LE(24);
  if (
    generation === 0n
    || Number((generation - 1n) % 2n) !== expectedSlot
    || payloadLength === 0n
    || payloadLength > BigInt(MAX_PAYLOAD_BYTES)
  ) reject("STORE_CORRUPT");
  return {
    slot: expectedSlot,
    generation,
    payloadLength: Number(payloadLength),
    payloadDigest: bytes.subarray(32, 64),
  };
}

function completeCandidate(header, payload) {
  if (header === null || !Buffer.isBuffer(payload)) return null;
  if (payload.byteLength !== header.payloadLength) return null;
  const digest = createHash("sha256").update(payload).digest();
  if (!digest.equals(header.payloadDigest)) return null;
  return { header, payload };
}

export function parseRelayV2BrokerCredentialBinaryObjects(objects) {
  const keys = Object.keys(objects).sort();
  if (
    keys.length !== OBJECT_NAMES.length
    || !keys.every((key, index) => key === [...OBJECT_NAMES].sort()[index])
  ) reject("STORE_FORMAT_UNSUPPORTED");
  if (OBJECT_NAMES.every((name) => objects[name] === null)) return { outcome: "missing" };

  const headers = [parseHeader(objects.header0, 0), parseHeader(objects.header1, 1)];
  const candidates = [
    completeCandidate(headers[0], objects.payload0),
    completeCandidate(headers[1], objects.payload1),
  ];
  const presentHeaders = headers.filter((header) => header !== null);
  if (presentHeaders.length === 0) reject("STORE_CORRUPT");

  let active;
  if (presentHeaders.length === 1) {
    if (presentHeaders[0].generation !== 1n || presentHeaders[0].slot !== 0) {
      reject("STORE_CORRUPT");
    }
    active = candidates[presentHeaders[0].slot];
    if (active === null) reject("STORE_CORRUPT");
  } else {
    const [left, right] = headers;
    const delta = left.generation > right.generation
      ? left.generation - right.generation
      : right.generation - left.generation;
    if (delta !== 1n) reject("STORE_CORRUPT");
    const higher = left.generation > right.generation ? left : right;
    active = candidates[higher.slot];
    if (active === null) reject("STORE_CORRUPT");
  }
  return {
    outcome: "present",
    generation: active.header.generation.toString(10),
    payload: Buffer.from(active.payload),
    payloadSha256: createHash("sha256").update(active.payload).digest("base64url"),
  };
}

export function captureContractFailure(operation) {
  try {
    return { outcome: "success", value: operation() };
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    return { outcome: "reject", errorCode: error.code };
  }
}
