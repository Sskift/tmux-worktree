import { createGunzip } from "node:zlib";
import {
  constants as fsConstants,
  lstat,
  mkdir,
  open,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const TAR_BLOCK_BYTES = 512;
const TAR_MAX_ENTRIES = 10_000;
const TAR_MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const TAR_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class NativeTarInspectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "NativeTarInspectionError";
  }
}

function fail(message) {
  throw new NativeTarInspectionError(message);
}

function safeTarMessage(error) {
  return error instanceof NativeTarInspectionError
    ? error.message
    : "tar selected file operation failed";
}

async function closeSelectedHandleAfter(handle, primaryError) {
  let closeFailed = false;
  try {
    await handle.close();
  } catch {
    closeFailed = true;
  }
  if (primaryError !== undefined && closeFailed) {
    fail(`${safeTarMessage(primaryError)}; cleanup also failed: selected file close failed`);
  }
  if (closeFailed) fail("tar selected file close failed");
  if (primaryError !== undefined) throw primaryError;
}

function isZeroBlock(block) {
  return block.every((value) => value === 0);
}

function directoryIdentity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameDirectoryIdentity(status, expected) {
  return status.dev === expected.dev && status.ino === expected.ino;
}

async function inspectDirectory(path, purpose, requirePrivate = false) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${purpose} cannot be inspected`);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail(`${purpose} is not a real directory`);
  }
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY
        | fsConstants.O_DIRECTORY
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_CLOEXEC,
    );
  } catch {
    fail(`${purpose} cannot be opened without following links`);
  }
  try {
    const descriptor = await handle.stat();
    const after = await lstat(path);
    const expected = directoryIdentity(descriptor);
    if (
      !descriptor.isDirectory()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameDirectoryIdentity(before, expected)
      || !sameDirectoryIdentity(after, expected)
    ) {
      fail(`${purpose} path and descriptor identities differ`);
    }
    if (
      requirePrivate
      && ((descriptor.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && descriptor.uid !== process.getuid()))
    ) {
      fail(`${purpose} is not private`);
    }
    return { path, purpose, handle, identity: expected };
  } catch (error) {
    let closeFailed = false;
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
    if (closeFailed) {
      fail(`${safeTarMessage(error)}; cleanup also failed: ${purpose} close failed`);
    }
    throw error;
  }
}

async function verifyDirectory(record) {
  const descriptor = await record.handle.stat();
  let current;
  try {
    current = await lstat(record.path);
  } catch {
    fail(`${record.purpose} identity cannot be inspected`);
  }
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameDirectoryIdentity(descriptor, record.identity)
    || !sameDirectoryIdentity(current, record.identity)
  ) {
    fail(`${record.purpose} identity changed`);
  }
}

function decodeTarString(block, start, length, field) {
  const bytes = block.subarray(start, start + length);
  const zero = bytes.indexOf(0);
  const valueBytes = zero === -1 ? bytes : bytes.subarray(0, zero);
  if (zero !== -1 && bytes.subarray(zero).some((value) => value !== 0)) {
    fail(`tar ${field} field is invalid`);
  }
  try {
    return UTF8.decode(valueBytes);
  } catch {
    fail(`tar ${field} field is not strict UTF-8`);
  }
}

function parseTarOctal(block, start, length, field) {
  const bytes = block.subarray(start, start + length);
  if ((bytes[0] & 0x80) !== 0) fail(`tar ${field} base-256 encoding is unsupported`);
  let text;
  try {
    text = new TextDecoder("ascii", { fatal: true }).decode(bytes);
  } catch {
    fail(`tar ${field} field is invalid`);
  }
  const trimmed = text.replace(/^ +/, "").replace(/[\0 ]+$/, "");
  if (trimmed.length === 0) return 0;
  if (!/^[0-7]+$/.test(trimmed)) fail(`tar ${field} field is invalid`);
  const value = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`tar ${field} field is out of range`);
  return value;
}

function verifyHeaderChecksum(block) {
  const expected = parseTarOctal(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < block.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) fail("tar header checksum is invalid");
}

function parseHeader(block) {
  verifyHeaderChecksum(block);
  const magic = decodeTarString(block, 257, 6, "magic");
  if (magic !== "ustar" && magic !== "ustar ") fail("tar header is not ustar");
  const name = decodeTarString(block, 0, 100, "name");
  const prefix = decodeTarString(block, 345, 155, "prefix");
  const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (rawPath.length === 0) fail("tar entry path is empty");
  const typeFlag = block[156];
  const type = typeFlag === 0 || typeFlag === 0x30
    ? "file"
    : typeFlag === 0x35
      ? "directory"
      : null;
  if (type === null) fail("tar entry type is not a regular file or directory");
  const linkName = decodeTarString(block, 157, 100, "linkname");
  if (linkName.length !== 0) fail("tar regular/directory entry has a link target");
  const size = parseTarOctal(block, 124, 12, "size");
  if (size > TAR_MAX_ENTRY_BYTES) fail("tar entry exceeds the bounded size");
  if (type === "directory" && size !== 0) fail("tar directory entry has data");
  const path = type === "directory" && rawPath.endsWith("/")
    ? rawPath.slice(0, -1)
    : rawPath;
  if (path.length === 0 || (type === "file" && path.endsWith("/"))) {
    fail("tar entry path/type combination is invalid");
  }
  return Object.freeze({ path, type, size });
}

class TarByteReader {
  #iterator;
  #chunk = Buffer.alloc(0);
  #offset = 0;
  #expandedBytes = 0;

  constructor(stream) {
    this.#iterator = stream[Symbol.asyncIterator]();
  }

  async #nextChunk() {
    while (this.#offset >= this.#chunk.byteLength) {
      const next = await this.#iterator.next();
      if (next.done) return false;
      this.#chunk = Buffer.from(next.value);
      this.#offset = 0;
      if (this.#chunk.byteLength === 0) continue;
    }
    return true;
  }

  async consume(length, onBytes = undefined) {
    if (!Number.isSafeInteger(length) || length < 0) fail("tar read length is invalid");
    let remaining = length;
    while (remaining > 0) {
      if (!await this.#nextChunk()) fail("tar archive is truncated");
      const take = Math.min(remaining, this.#chunk.byteLength - this.#offset);
      const bytes = this.#chunk.subarray(this.#offset, this.#offset + take);
      this.#offset += take;
      remaining -= take;
      this.#expandedBytes += take;
      if (this.#expandedBytes > TAR_MAX_EXPANDED_BYTES) {
        fail("tar archive exceeds the bounded expanded size");
      }
      if (onBytes !== undefined) await onBytes(bytes);
    }
  }

  async read(length) {
    const result = Buffer.alloc(length);
    let offset = 0;
    await this.consume(length, async (bytes) => {
      result.set(bytes, offset);
      offset += bytes.byteLength;
    });
    return result;
  }

  async assertRemainingZero() {
    while (await this.#nextChunk()) {
      const bytes = this.#chunk.subarray(this.#offset);
      this.#offset = this.#chunk.byteLength;
      this.#expandedBytes += bytes.byteLength;
      if (
        this.#expandedBytes > TAR_MAX_EXPANDED_BYTES
        || bytes.some((value) => value !== 0)
      ) {
        fail("tar archive has data after its end marker");
      }
    }
  }
}

function checkedDestination(root, relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.split("/").some((component) => (
      component.length === 0 || component === "." || component === ".."
    ))
  ) {
    fail("tar extraction destination is invalid");
  }
  const destination = resolve(root, ...relativePath.split("/"));
  const rootPrefix = `${resolve(root)}${sep}`;
  if (!destination.startsWith(rootPrefix)) fail("tar extraction destination escapes its root");
  return destination;
}

async function ensureSelectedParent(root, relativePath, directories) {
  const components = relativePath.split("/").slice(0, -1);
  let parent = root;
  for (const component of components) {
    await verifyDirectory(parent);
    const childPath = join(parent.path, component);
    const known = directories.get(childPath);
    if (known !== undefined) {
      await verifyDirectory(known);
      parent = known;
      continue;
    }
    try {
      await mkdir(childPath, { mode: 0o700 });
    } catch {
      fail("tar extraction parent was not created exclusively by the inspector");
    }
    const child = await inspectDirectory(
      childPath,
      "tar extraction parent directory",
      true,
    );
    directories.set(childPath, child);
    await verifyDirectory(parent);
    parent = child;
  }
  return parent;
}

async function writeSelectedRegularFile(reader, size, destination, parent) {
  await verifyDirectory(parent);
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW
    | fsConstants.O_CLOEXEC;
  const handle = await open(destination, flags, 0o600);
  let position = 0;
  let primaryError;
  try {
    const createdStatus = await handle.stat();
    const createdIdentity = directoryIdentity(createdStatus);
    if (!createdStatus.isFile() || createdStatus.size !== 0 || createdStatus.nlink !== 1) {
      fail("tar selected file was not created as a fresh regular file");
    }
    await verifyDirectory(parent);
    await reader.consume(size, async (bytes) => {
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          position + written,
        );
        if (result.bytesWritten <= 0) fail("tar selected file write made no progress");
        written += result.bytesWritten;
      }
      position += bytes.byteLength;
    });
    await handle.sync();
    const status = await handle.stat();
    if (
      !status.isFile()
      || status.size !== size
      || status.nlink !== 1
      || !sameDirectoryIdentity(status, createdIdentity)
    ) {
      fail("tar selected file is not the created regular file");
    }
    await verifyDirectory(parent);
  } catch (error) {
    primaryError = error;
  }
  await closeSelectedHandleAfter(handle, primaryError);
}

async function closeInspectedDirectories(directories, primaryError) {
  const failures = [];
  for (const record of [...directories.values()].reverse()) {
    try {
      await record.handle.close();
    } catch {
      failures.push(`${record.purpose} close failed`);
    }
  }
  if (primaryError !== undefined && failures.length > 0) {
    fail(`${safeTarMessage(primaryError)}; cleanup also failed: ${failures.join("; ")}`);
  }
  if (failures.length > 0) fail(failures.join("; "));
  if (primaryError !== undefined) throw primaryError;
}

/**
 * Parses the archive itself, rejects every link/special type, and materializes
 * only an exact allowlist as newly-created regular files.
 */
export async function inspectAndExtractNpmPackTar({
  tarballHandle,
  extractionRoot,
  selectedFiles,
}) {
  if (!(selectedFiles instanceof Map)) fail("tar selected-file map is invalid");
  const selectedDestinations = new Map();
  for (const [tarPath, relativePath] of selectedFiles) {
    if (typeof tarPath !== "string" || tarPath.length === 0) {
      fail("tar selected path is invalid");
    }
    selectedDestinations.set(tarPath, checkedDestination(extractionRoot, relativePath));
  }

  const rootDirectory = await inspectDirectory(
    resolve(extractionRoot),
    "tar extraction root",
  );
  const inspectedDirectories = new Map([[rootDirectory.path, rootDirectory]]);

  const compressed = tarballHandle.createReadStream({ autoClose: false, start: 0 });
  const gunzip = createGunzip();
  compressed.on("error", (error) => gunzip.destroy(error));
  compressed.pipe(gunzip);
  const reader = new TarByteReader(gunzip);
  const entries = [];
  const seen = new Set();
  const extracted = new Map();
  let firstZeroSeen = false;
  let primaryError;

  try {
    for (;;) {
      const block = await reader.read(TAR_BLOCK_BYTES);
      if (isZeroBlock(block)) {
        if (firstZeroSeen) {
          await reader.assertRemainingZero();
          break;
        }
        firstZeroSeen = true;
        continue;
      }
      if (firstZeroSeen) fail("tar archive has an incomplete end marker");
      const entry = parseHeader(block);
      if (seen.has(entry.path)) fail("tar archive contains duplicate paths");
      if (entries.length >= TAR_MAX_ENTRIES) {
        fail("tar archive exceeds the bounded entry count");
      }
      seen.add(entry.path);
      entries.push(entry);

      const destination = selectedDestinations.get(entry.path);
      if (destination !== undefined) {
        if (entry.type !== "file") fail("selected tar entry is not a regular file");
        const relativeDestination = selectedFiles.get(entry.path);
        const parent = await ensureSelectedParent(
          rootDirectory,
          relativeDestination,
          inspectedDirectories,
        );
        await writeSelectedRegularFile(reader, entry.size, destination, parent);
        extracted.set(entry.path, destination);
      } else {
        await reader.consume(entry.size);
      }
      const padding = (TAR_BLOCK_BYTES - (entry.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
      await reader.consume(padding);
    }
    for (const selectedPath of selectedDestinations.keys()) {
      if (!extracted.has(selectedPath)) fail("npm pack tarball is missing a selected file");
    }
  } catch (error) {
    compressed.destroy();
    gunzip.destroy();
    primaryError = error;
  }
  await closeInspectedDirectories(inspectedDirectories, primaryError);
  return Object.freeze({
    entries: Object.freeze(entries),
    extracted,
  });
}
