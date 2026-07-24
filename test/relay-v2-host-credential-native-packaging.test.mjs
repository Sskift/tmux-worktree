import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertNativeBinaryMatchesDescriptor,
  inspectNativeBinaryHeader,
  validateNpmPackTarEntries,
} from "../scripts/relay-v2-host-credential-native.mjs";

const targetModule = await import(
  "../dist/relay/v2/hostCredentialNativeTarget.js"
);
const brokerTargetModule = await import(
  "../dist/relay/v2/brokerCredentialStateStoreNativeTarget.js"
);
const fixture = JSON.parse(readFileSync(
  new URL(
    "../contracts/relay/v2/host-credential-atomic-file-cell-v1/native-artifact-cases-v1.json",
    import.meta.url,
  ),
  "utf8",
));

function descriptor(target) {
  const selected = targetModule.getRelayV2HostCredentialNativeTargetDescriptor(target);
  assert.notEqual(selected, null);
  return selected;
}

// The same-target frozen Broker sibling artifact names come from the Broker
// owner's own fixed descriptor module; literals are never copied here.
function siblingFileNames(target) {
  const broker = brokerTargetModule
    .getRelayV2BrokerCredentialStateStoreNativeTargetDescriptor(target);
  assert.notEqual(broker, null);
  return [broker.runtimeArtifact.moduleSpecifier.slice("./native/".length)];
}

function headerBytes(header) {
  if (header.family === "macho") {
    const bytes = new Uint8Array(32);
    if (header.byteOrder === "little") bytes.set([0xcf, 0xfa, 0xed, 0xfe]);
    else bytes.set([0xfe, 0xed, 0xfa, 0xcf]);
    const littleEndian = header.byteOrder === "little";
    const view = new DataView(bytes.buffer);
    view.setUint32(4, Number(header.cpuType), littleEndian);
    view.setUint32(12, header.fileType, littleEndian);
    return bytes;
  }
  if (header.family === "elf") {
    const bytes = new Uint8Array(64);
    bytes.set([
      0x7f,
      0x45,
      0x4c,
      0x46,
      header.class,
      header.data,
      header.headerVersion,
      header.osAbi,
    ]);
    const view = new DataView(bytes.buffer);
    view.setUint16(16, header.type, true);
    view.setUint16(18, header.machine, true);
    view.setUint32(20, header.version, true);
    return bytes;
  }
  return new Uint8Array([0x4d, 0x5a, ...new Uint8Array(62)]);
}

test("native binary header identity follows the frozen Mach-O/ELF rules", () => {
  for (const entry of fixture.binaryHeaderCases) {
    const bytes = headerBytes(entry.header);
    if (entry.accepted) {
      const expected = { platform: entry.platform, architecture: entry.architecture };
      assert.deepEqual(inspectNativeBinaryHeader(bytes), expected, entry.name);
      assert.deepEqual(
        assertNativeBinaryMatchesDescriptor(
          bytes,
          descriptor(`${entry.platform}-${entry.architecture}`),
        ),
        expected,
        entry.name,
      );
    } else {
      assert.throws(() => inspectNativeBinaryHeader(bytes), undefined, entry.name);
    }
  }

  // A selected-target mismatch is rejected even for an otherwise valid header.
  assert.throws(
    () => assertNativeBinaryMatchesDescriptor(
      headerBytes({ family: "macho", byteOrder: "little", cpuType: "0x01000007", fileType: 6 }),
      descriptor("darwin-arm64"),
    ),
    /does not match the selected target/,
  );
  assert.throws(
    () => assertNativeBinaryMatchesDescriptor(
      headerBytes({
        family: "elf",
        class: 2,
        data: 1,
        headerVersion: 1,
        osAbi: 0,
        type: 3,
        version: 1,
        machine: 183,
      }),
      descriptor("linux-x64"),
    ),
    /does not match the selected target/,
  );
});

test("npm pack native layout is exact per owner with only the same-target frozen sibling allowed", () => {
  for (const entry of fixture.packedLayoutCases) {
    const selected = descriptor(entry.selectedTarget);
    const fixed = selected.packedRelativePath;
    const siblings = siblingFileNames(entry.selectedTarget);
    const extras = [
      ...(entry.extraNativePaths ?? []).map((path) => ({ path, type: "file", size: 1 })),
      ...(entry.extraNativeDirectories ?? []).map((path) => ({
        path,
        type: "directory",
        size: 0,
      })),
    ];
    if (entry.brokerSiblingTarget !== undefined) {
      extras.push({
        path: `package/dist/relay/v2/native/${siblingFileNames(entry.brokerSiblingTarget)[0]}`,
        type: "file",
        size: 1,
      });
    }
    const entries = [
      { path: "package/package.json", type: "file", size: 100 },
      { path: "package/dist/cli.cjs", type: "file", size: 100 },
      { path: fixed, type: "file", size: 100 },
      ...extras,
    ];
    if (entry.accepted) {
      assert.equal(validateNpmPackTarEntries(entries, selected, siblings), fixed, entry.name);
    } else {
      assert.throws(
        () => validateNpmPackTarEntries(entries, selected, siblings),
        /exactly the selected native artifact/,
        entry.name,
      );
    }
  }

  // A directory entry for the shared native directory itself stays allowed.
  const selected = descriptor("darwin-arm64");
  const fixed = selected.packedRelativePath;
  const siblings = siblingFileNames("darwin-arm64");
  assert.equal(
    validateNpmPackTarEntries([
      { path: "package/package.json", type: "file", size: 100 },
      { path: "package/dist/relay/v2/native", type: "directory", size: 0 },
      { path: fixed, type: "file", size: 100 },
    ], selected, siblings),
    fixed,
  );

  // Duplicate entries and malformed paths stay invalid regardless of the
  // native subset.
  assert.throws(
    () => validateNpmPackTarEntries([
      { path: fixed, type: "file", size: 1 },
      { path: fixed, type: "file", size: 1 },
    ], selected, siblings),
    /duplicate entries/,
  );
  assert.throws(
    () => validateNpmPackTarEntries([
      { path: fixed, type: "link", size: 1 },
    ], selected, siblings),
    /layout is invalid/,
  );
});
