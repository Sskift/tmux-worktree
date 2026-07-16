import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const contractRoot = new URL(
  "../../contracts/relay/v2/broker-credential-state-store-v1/",
  import.meta.url,
);

const HEADER_BYTES = 128;
const HEADER0_OFFSET = 0;
const HEADER1_OFFSET = 128;
const HEADER_CHECKSUM_OFFSET = 0;
const HEADER_CHECKSUM_LENGTH = 96;
const PAYLOAD0_OFFSET = 256;
const PAYLOAD1_OFFSET = 67109120;
const CONTAINER_FILE_BYTES = 134217984;
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

function decodeContainer(container) {
  if (container === null) return null;
  return {
    fileLength: container.fileLength,
    segments: container.segments.map((segment, index) => ({
      offset: segment.offset,
      bytes: decodeBase64(segment.bytesBase64, `segments[${index}]`),
    })),
  };
}

export function loadRelayV2BrokerCredentialStateStoreCorpus() {
  const manifest = readJson("manifest.json");
  const goldenFile = readJson("golden-binary.json");
  const golden = goldenFile.cases.map((fixture) => ({
    ...fixture,
    container: decodeContainer(fixture.container),
  }));
  return {
    manifest,
    golden,
    goldenEncoding: goldenFile.encoding,
    goldenFixtureFormatVersion: goldenFile.fixtureFormatVersion,
    goldenByName: new Map(golden.map((fixture) => [fixture.name, fixture])),
    corruptFile: readJson("corrupt-binary.json"),
    nativeInterface: readJson("native-interface-cases.json"),
  };
}

export function materializeRelayV2BrokerCredentialCorruptCases(corpus) {
  return corpus.corruptFile.vectors.map((vector) => {
    const source = corpus.goldenByName.get(vector.deriveFrom);
    if (!source) throw new Error(`unknown broker credential fixture ${vector.deriveFrom}`);
    return { ...vector, container: source.container };
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

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || !actual.every((key, index) => key === sortedExpected[index])
  ) throw new Error(`${label} has an invalid schema`);
}

function assertRange(offset, length) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > CONTAINER_FILE_BYTES
  ) throw new Error("fixture range is outside the container");
}

class SparseRangeReader {
  #segments;
  #overlays = [];

  constructor(segments) {
    this.#segments = segments;
  }

  addOverlay(offset, bytes) {
    assertRange(offset, bytes.byteLength);
    this.#overlays.push({ offset, bytes: Buffer.from(bytes) });
  }

  read(offset, length) {
    assertRange(offset, length);
    const result = Buffer.alloc(length, 0);
    const apply = (segment) => {
      const start = Math.max(offset, segment.offset);
      const end = Math.min(offset + length, segment.offset + segment.bytes.byteLength);
      if (start >= end) return;
      segment.bytes.copy(
        result,
        start - offset,
        start - segment.offset,
        end - segment.offset,
      );
    };
    for (const segment of this.#segments) apply(segment);
    for (const overlay of this.#overlays) apply(overlay);
    return result;
  }

  hasNonZero(offset, length) {
    assertRange(offset, length);
    const end = offset + length;
    const entries = [...this.#segments, ...this.#overlays].filter((entry) => (
      entry.offset < end && entry.offset + entry.bytes.byteLength > offset
    ));
    const boundaries = new Set([offset, end]);
    for (const entry of entries) {
      boundaries.add(Math.max(offset, entry.offset));
      boundaries.add(Math.min(end, entry.offset + entry.bytes.byteLength));
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const start = ordered[index];
      const rangeLength = ordered[index + 1] - start;
      if (
        rangeLength > 0
        && entries.some((entry) => (
          entry.offset < start + rangeLength && entry.offset + entry.bytes.byteLength > start
        ))
        && this.read(start, rangeLength).some((value) => value !== 0)
      ) return true;
    }
    return false;
  }
}

function applyMutation(reader, mutation) {
  switch (mutation.kind) {
    case "set-file-length":
      return;
    case "write-byte": {
      const write = Buffer.alloc(1);
      write.writeUInt8(mutation.value);
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "write-u16-le": {
      const write = Buffer.alloc(2);
      write.writeUInt16LE(mutation.value);
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "write-u32-le": {
      const write = Buffer.alloc(4);
      write.writeUInt32LE(mutation.value);
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "write-u64-le": {
      const write = Buffer.alloc(8);
      write.writeBigUInt64LE(BigInt(mutation.value));
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "xor-byte": {
      const write = reader.read(mutation.offset, 1);
      write[0] ^= mutation.value;
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "zero-range":
      assertRange(mutation.offset, mutation.length);
      reader.addOverlay(mutation.offset, Buffer.alloc(mutation.length));
      return;
    case "write-bytes": {
      const write = decodeBase64(mutation.bytesBase64, "mutation bytes");
      reader.addOverlay(mutation.offset, write);
      return;
    }
    case "recompute-header-checksum": {
      assertRange(mutation.headerOffset, HEADER_BYTES);
      const checksum = createHash("sha256")
        .update(reader.read(
          mutation.headerOffset + HEADER_CHECKSUM_OFFSET,
          HEADER_CHECKSUM_LENGTH,
        ))
        .digest();
      reader.addOverlay(mutation.headerOffset + 96, checksum);
      return;
    }
    default:
      throw new Error(`unknown broker credential fixture mutation ${mutation.kind}`);
  }
}

function openSparseContainer(container, mutations) {
  exactObjectKeys(container, ["fileLength", "segments"], "container");
  if (!Array.isArray(container.segments)) throw new Error("container segments are not an array");
  let fileLength = container.fileLength;
  for (const mutation of mutations) {
    if (mutation.kind === "set-file-length") fileLength = mutation.value;
  }
  if (fileLength !== CONTAINER_FILE_BYTES) reject("STORE_CORRUPT");

  const segments = container.segments.map((segment, index) => {
    exactObjectKeys(segment, ["offset", "bytes"], `segment[${index}]`);
    if (
      !Number.isSafeInteger(segment.offset)
      || segment.offset < 0
      || !Buffer.isBuffer(segment.bytes)
      || segment.offset + segment.bytes.byteLength > CONTAINER_FILE_BYTES
    ) throw new Error(`segment[${index}] is outside the container`);
    return segment;
  }).sort((left, right) => left.offset - right.offset);
  let previousEnd = 0;
  for (const segment of segments) {
    if (segment.offset < previousEnd) throw new Error("fixture segments overlap");
    previousEnd = segment.offset + segment.bytes.byteLength;
  }
  const reader = new SparseRangeReader(segments);
  for (const mutation of mutations) applyMutation(reader, mutation);
  return reader;
}

function parseHeader(reader, headerOffset, expectedSlot) {
  const bytes = reader.read(headerOffset, HEADER_BYTES);
  if (bytes.every((value) => value === 0)) return null;
  const checksum = createHash("sha256")
    .update(bytes.subarray(
      HEADER_CHECKSUM_OFFSET,
      HEADER_CHECKSUM_OFFSET + HEADER_CHECKSUM_LENGTH,
    ))
    .digest();
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

function completeCandidate(reader, header) {
  if (header === null) return null;
  const offset = header.slot === 0 ? PAYLOAD0_OFFSET : PAYLOAD1_OFFSET;
  const hash = createHash("sha256");
  const chunkBytes = 64 * 1024;
  for (let readOffset = 0; readOffset < header.payloadLength; readOffset += chunkBytes) {
    const length = Math.min(chunkBytes, header.payloadLength - readOffset);
    hash.update(reader.read(offset + readOffset, length));
  }
  const digest = hash.digest();
  if (!digest.equals(header.payloadDigest)) return null;
  return { header, payloadOffset: offset };
}

export function parseRelayV2BrokerCredentialBinaryContainer(container, mutations = []) {
  if (container === null) {
    if (mutations.length !== 0) throw new Error("absent container cannot have mutations");
    return { outcome: "missing" };
  }
  const reader = openSparseContainer(container, mutations);
  const headers = [
    parseHeader(reader, HEADER0_OFFSET, 0),
    parseHeader(reader, HEADER1_OFFSET, 1),
  ];
  if (headers[0] === null && headers[1] === null) {
    if (
      reader.hasNonZero(PAYLOAD0_OFFSET, MAX_PAYLOAD_BYTES)
      || reader.hasNonZero(PAYLOAD1_OFFSET, MAX_PAYLOAD_BYTES)
    ) reject("STORE_CORRUPT");
    return { outcome: "missing" };
  }
  const candidates = [
    completeCandidate(reader, headers[0]),
    completeCandidate(reader, headers[1]),
  ];
  const presentHeaders = headers.filter((header) => header !== null);

  let active;
  if (presentHeaders.length === 1) {
    if (presentHeaders[0].generation !== 1n || presentHeaders[0].slot !== 0) {
      reject("STORE_CORRUPT");
    }
    active = candidates[0];
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
  const payload = reader.read(active.payloadOffset, active.header.payloadLength);
  return {
    outcome: "present",
    generation: active.header.generation.toString(10),
    payload,
    payloadSha256: createHash("sha256").update(payload).digest("base64url"),
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
