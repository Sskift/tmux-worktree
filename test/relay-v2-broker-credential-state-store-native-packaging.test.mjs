import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertNativeBinaryMatchesDescriptor,
  inspectNativeBinaryHeader,
  validateNpmPackTarEntries,
} from "../scripts/relay-v2-broker-credential-native.mjs";
import {
  inspectAndExtractNpmPackTar,
} from "../scripts/internal/relayV2BrokerCredentialNativeTar.mjs";

const targetModule = await import(
  "../dist/relay/v2/brokerCredentialStateStoreNativeTarget.js"
);

function descriptor(target) {
  const selected = targetModule
    .getRelayV2BrokerCredentialStateStoreNativeTargetDescriptor(target);
  assert.notEqual(selected, null);
  return selected;
}

function machO64(cpuType) {
  const bytes = new Uint8Array(32);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, cpuType, true);
  view.setUint32(12, 6, true);
  return bytes;
}

function elf64(machine, osAbi = 0) {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, osAbi]);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 3, true);
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  return bytes;
}

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  assert.ok(encoded.length < length);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  assert.equal(Buffer.byteLength(encoded), length);
  header.write(encoded, offset, length, "ascii");
}

function tarWithEntry({ name, prefix = "", typeFlag = "0", linkName = "", body = Buffer.alloc(0) }) {
  const header = Buffer.alloc(512);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, body.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(typeFlag, 156, 1, "ascii");
  writeTarString(header, 157, 100, linkName);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeTarString(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
}

test("native packaging reads Mach-O/ELF identity and rejects a selected-target mismatch", () => {
  const cases = [
    ["darwin-arm64", machO64(0x0100000c), { platform: "darwin", architecture: "arm64" }],
    ["darwin-x64", machO64(0x01000007), { platform: "darwin", architecture: "x64" }],
    ["linux-arm64", elf64(183), { platform: "linux", architecture: "arm64" }],
    ["linux-x64", elf64(62, 3), { platform: "linux", architecture: "x64" }],
  ];
  for (const [target, bytes, expected] of cases) {
    assert.deepEqual(inspectNativeBinaryHeader(bytes), expected, target);
    assert.deepEqual(assertNativeBinaryMatchesDescriptor(bytes, descriptor(target)), expected);
  }

  assert.throws(
    () => assertNativeBinaryMatchesDescriptor(
      machO64(0x01000007),
      descriptor("darwin-arm64"),
    ),
    /does not match the selected target/,
  );
  assert.throws(
    () => inspectNativeBinaryHeader(new Uint8Array([0x4d, 0x5a, ...new Uint8Array(62)])),
    /format is unsupported/,
  );
});

test("npm pack native layout contains only the fixed artifact for its selected target", () => {
  const selected = descriptor("darwin-arm64");
  const fixed = "package/dist/relay/v2/native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node";
  const baseEntries = [
    { path: "package/package.json", type: "file", size: 100 },
    { path: "package/dist/cli.cjs", type: "file", size: 100 },
    { path: fixed, type: "file", size: 100 },
  ];
  assert.equal(validateNpmPackTarEntries(baseEntries, selected), fixed);

  const extras = [
    "package/dist/relay/v2/native/relay-v2-broker-credential-state-store-v1-darwin-x64.node",
    "package/dist/relay/v2/native/stale-build.bin",
    "package/alternate/addon.node",
    "package/dist/relay/v2/native/raw-binding.dylib",
  ];
  for (const extra of extras) {
    assert.throws(
      () => validateNpmPackTarEntries([
        ...baseEntries,
        { path: extra, type: "file", size: 1 },
      ], selected),
      /exactly the selected native artifact/,
      extra,
    );
  }
});

test("npm pack tar inspection accepts ustar prefix and rejects corrupt/extended/link headers", async () => {
  const fixed = "package/dist/relay/v2/native/relay-v2-broker-credential-state-store-v1-darwin-arm64.node";
  const temporaryRoot = await mkdtemp(join(tmpdir(), "tw-native-tar-link-test-"));
  try {
    const prefix = "package/dist/relay/v2/native";
    const name = "relay-v2-broker-credential-state-store-v1-darwin-arm64.node";
    const body = Buffer.from("selected regular bytes");
    const prefixedTarball = join(temporaryRoot, "prefix.tgz");
    const prefixedUnpack = join(temporaryRoot, "unpack-prefix");
    await mkdir(prefixedUnpack);
    await writeFile(
      prefixedTarball,
      gzipSync(tarWithEntry({ name, prefix, body })),
    );
    const prefixedHandle = await open(
      prefixedTarball,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
    try {
      const inspected = await inspectAndExtractNpmPackTar({
        tarballHandle: prefixedHandle,
        extractionRoot: prefixedUnpack,
        selectedFiles: new Map([[fixed, fixed]]),
      });
      assert.deepEqual(inspected.entries, [{ path: fixed, type: "file", size: body.length }]);
      assert.deepEqual(await readFile(inspected.extracted.get(fixed)), body);
    } finally {
      await prefixedHandle.close();
    }

    const corrupt = tarWithEntry({ name, prefix, body });
    corrupt[0] ^= 1;
    const cases = [
      ["checksum", corrupt, /checksum is invalid/],
      ["hardlink", "1", "package/package.json"],
      ["symlink", "2", "../../outside.node"],
      ["pax", "x", ""],
      ["gnu-longname", "L", ""],
    ];
    for (const entryCase of cases) {
      const [label] = entryCase;
      const rawTar = label === "checksum"
        ? entryCase[1]
        : tarWithEntry({
            name: fixed,
            typeFlag: entryCase[1],
            linkName: entryCase[2],
          });
      const expectedError = label === "checksum"
        ? entryCase[2]
        : /type is not a regular file or directory/;
      const tarball = join(temporaryRoot, `${label}.tgz`);
      const extractionRoot = join(temporaryRoot, `unpack-${label}`);
      await mkdir(extractionRoot);
      await writeFile(tarball, gzipSync(rawTar));
      const handle = await open(
        tarball,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
      );
      try {
        await assert.rejects(
          inspectAndExtractNpmPackTar({
            tarballHandle: handle,
            extractionRoot,
            selectedFiles: new Map([[fixed, fixed]]),
          }),
          expectedError,
          label,
        );
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true });
  }
});
