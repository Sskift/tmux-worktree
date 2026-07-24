import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const COPY_CHUNK_BYTES = 1024 * 1024;

export class FdOwnedNativeStageError extends Error {
  constructor(message) {
    super(message);
    this.name = "FdOwnedNativeStageError";
  }
}

function fail(message) {
  throw new FdOwnedNativeStageError(message);
}

function identity(status) {
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

function sameIdentity(status, expected) {
  return expected !== undefined
    && status.dev === expected.dev
    && status.ino === expected.ino;
}

function safeStageMessage(error) {
  return error instanceof FdOwnedNativeStageError
    ? error.message
    : "native staging operation failed";
}

async function readHeaderFromHandle(handle) {
  const bytes = new Uint8Array(64);
  const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
  return bytes.subarray(0, bytesRead);
}

async function digestHandle(handle, size) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) fail("native artifact read made no progress");
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

async function copyBetweenHandles(source, destination, size) {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    const requested = Math.min(buffer.byteLength, size - position);
    const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (bytesRead <= 0) fail("Cargo native artifact read made no progress");
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await destination.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (bytesWritten <= 0) fail("native staging write made no progress");
      written += bytesWritten;
    }
    position += bytesRead;
  }
}

async function closeHandle(handle, purpose) {
  try {
    await handle.close();
  } catch {
    fail(`${purpose} close failed`);
  }
}

async function openNoFollowRegular(path) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
  } catch {
    fail("native artifact cannot be opened without following links");
  }
  try {
    const status = await handle.stat();
    if (!status.isFile() || !Number.isSafeInteger(status.size) || status.size < 0) {
      fail("native artifact is not a bounded regular file");
    }
    return Object.freeze({ handle, status, identity: identity(status) });
  } catch (error) {
    let closeFailure;
    try {
      await handle.close();
    } catch {
      closeFailure = "native artifact descriptor close failed";
    }
    if (closeFailure !== undefined) {
      throw new FdOwnedNativeStageError(
        `${safeStageMessage(error)}; cleanup also failed: ${closeFailure}`,
      );
    }
    throw error;
  }
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
    if (
      !descriptor.isDirectory()
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameIdentity(before, identity(descriptor))
      || !sameIdentity(after, identity(descriptor))
    ) {
      fail(`${purpose} path and descriptor identities differ`);
    }
    if (
      requirePrivate
      && ((descriptor.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && descriptor.uid !== process.getuid()))
    ) {
      fail(`${purpose} is not private to the current account`);
    }
    return {
      path,
      purpose,
      handle,
      identity: identity(descriptor),
    };
  } catch (error) {
    let closeFailure;
    try {
      await handle.close();
    } catch {
      closeFailure = `${purpose} descriptor close failed`;
    }
    if (closeFailure !== undefined) {
      throw new FdOwnedNativeStageError(
        `${safeStageMessage(error)}; cleanup also failed: ${closeFailure}`,
      );
    }
    throw error;
  }
}

async function verifyDirectory(record) {
  if (record?.identity === undefined || record.handle === undefined) {
    fail(`${record?.purpose ?? "created directory"} identity was not established`);
  }
  const descriptor = await record.handle.stat();
  let current;
  try {
    current = await lstat(record.path);
  } catch {
    fail(`${record.purpose} path identity cannot be inspected`);
  }
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameIdentity(descriptor, record.identity)
    || !sameIdentity(current, record.identity)
  ) {
    fail(`${record.purpose} identity changed`);
  }
}

async function verifyLeaf(path, expected, purpose) {
  let status;
  try {
    status = await lstat(path);
  } catch {
    fail(`${purpose} identity cannot be inspected`);
  }
  if (!status.isFile() || status.isSymbolicLink() || !sameIdentity(status, expected)) {
    fail(`${purpose} identity changed`);
  }
  return status;
}

async function unlinkOwnedLeaf(parent, leaf) {
  await verifyDirectory(parent);
  if (leaf.identity === undefined) {
    fail(`${leaf.purpose} identity was not established; preserved`);
  }
  await verifyLeaf(leaf.path, leaf.identity, `${leaf.purpose} cleanup`);
  try {
    await unlink(leaf.path);
  } catch {
    fail(`${leaf.purpose} cleanup unlink failed`);
  }
  await verifyDirectory(parent);
}

async function removeOwnedDirectory(parent, child) {
  await verifyDirectory(parent);
  if (child.identity === undefined || child.handle === undefined) {
    fail(`${child.purpose} identity was not established; preserved`);
  }
  await verifyDirectory(child);
  if ((await readdir(child.path)).length !== 0) {
    fail(`${child.purpose} cleanup found unknown remaining entries; preserved`);
  }
  await closeHandle(child.handle, `${child.purpose} descriptor`);
  child.handle = undefined;
  await verifyDirectory(parent);
  let current;
  try {
    current = await lstat(child.path);
  } catch {
    fail(`${child.purpose} cleanup identity cannot be inspected`);
  }
  if (!sameIdentity(current, child.identity)) {
    fail(`${child.purpose} cleanup refused an identity replacement`);
  }
  try {
    await rmdir(child.path);
  } catch {
    fail(`${child.purpose} cleanup removal failed`);
  }
  await verifyDirectory(parent);
}

async function closeRecordedHandle(record, failures) {
  if (record?.handle === undefined) return;
  try {
    await record.handle.close();
    record.handle = undefined;
  } catch {
    failures.push(`${record.purpose} descriptor close failed`);
  }
}

async function cleanupBeforeCommit(created, handles) {
  const failures = [];
  await closeRecordedHandle(handles.temporary, failures);
  await closeRecordedHandle(handles.source, failures);

  if (created.temporaryFile !== undefined) {
    if (created.temporaryDirectory?.identity === undefined) {
      failures.push("private native staging directory identity was not established; preserved");
    } else {
      try {
        await unlinkOwnedLeaf(created.temporaryDirectory, created.temporaryFile);
      } catch (error) {
        failures.push(safeStageMessage(error));
      }
    }
  }
  if (created.temporaryDirectory !== undefined) {
    if (created.temporaryDirectory.identity === undefined) {
      failures.push("private native staging directory identity was not established; preserved");
    } else {
      try {
        await removeOwnedDirectory(handles.loaderDirectory, created.temporaryDirectory);
      } catch (error) {
        failures.push(safeStageMessage(error));
      }
    }
  }
  if (created.finalDirectory !== undefined) {
    if (created.finalDirectory.identity === undefined) {
      failures.push("native final directory identity was not established; preserved");
    } else if (
      created.finalDirectory.preExistingNames !== null
      && created.finalDirectory.preExistingNames !== undefined
    ) {
      // An adopted pre-existing final directory is never removed; only its
      // held descriptor is closed.
      await closeRecordedHandle(created.finalDirectory, failures);
    } else {
      try {
        await removeOwnedDirectory(handles.loaderDirectory, created.finalDirectory);
      } catch (error) {
        failures.push(safeStageMessage(error));
      }
    }
  }
  await closeRecordedHandle(handles.loaderDirectory, failures);
  return failures;
}

async function cleanupAfterCommit(created, handles) {
  const failures = [];
  await closeRecordedHandle(handles.temporary, failures);
  await closeRecordedHandle(handles.source, failures);
  if (created.temporaryFile !== undefined) {
    try {
      await unlinkOwnedLeaf(created.temporaryDirectory, created.temporaryFile);
    } catch (error) {
      failures.push(safeStageMessage(error));
    }
  }
  if (created.temporaryDirectory !== undefined) {
    try {
      await removeOwnedDirectory(handles.loaderDirectory, created.temporaryDirectory);
    } catch (error) {
      failures.push(safeStageMessage(error));
    }
  }
  await closeRecordedHandle(created.finalDirectory, failures);
  await closeRecordedHandle(handles.loaderDirectory, failures);
  return failures;
}

export async function verifyNativeArtifactFd(path, verifyHeader, options = {}) {
  const owned = await openNoFollowRegular(path);
  let result;
  let primaryError;
  try {
    verifyHeader(await readHeaderFromHandle(owned.handle));
    if (options.requireSingleLink && owned.status.nlink !== 1) {
      fail("native artifact has an invalid link count");
    }
    await verifyLeaf(path, owned.identity, "native artifact");
    result = Object.freeze({
      size: owned.status.size,
      dev: owned.identity.dev,
      ino: owned.identity.ino,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    await owned.handle.close();
  } catch {
    const closeFailure = "native artifact descriptor close failed";
    if (primaryError !== undefined) {
      throw new FdOwnedNativeStageError(
        `${safeStageMessage(primaryError)}; cleanup also failed: ${closeFailure}`,
      );
    }
    fail(closeFailure);
  }
  if (primaryError !== undefined) throw primaryError;
  return result;
}

/**
 * All byte/header/digest/layout proof precedes the hard-link commit point.
 * After link succeeds, the final name is never rolled back; only the private
 * random temporary directory is identity-checked and removed. When the final
 * directory already exists, it is adopted only if every pre-existing entry is
 * in allowedPreExistingFinalEntries (frozen sibling-owner artifact names); an
 * adopted directory is never replaced or removed by cleanup, and the commit
 * still adds only the new final name.
 */
export async function atomicallyStageFdOwnedNativeArtifact({
  sourcePath,
  finalPath,
  verifyHeader,
  allowedPreExistingFinalEntries = [],
}) {
  const finalDirectoryPath = dirname(finalPath);
  const loaderDirectoryPath = dirname(finalDirectoryPath);
  const created = {};
  const handles = {};
  let committed = false;
  let primaryError;

  try {
    handles.source = {
      ...(await openNoFollowRegular(sourcePath)),
      purpose: "Cargo native artifact",
    };
    verifyHeader(await readHeaderFromHandle(handles.source.handle));
    await verifyLeaf(sourcePath, handles.source.identity, "Cargo native artifact");

    handles.loaderDirectory = await inspectDirectory(
      loaderDirectoryPath,
      "ordinary build loader directory",
    );

    const allowedPreExisting = new Set(allowedPreExistingFinalEntries);
    let preExistingFinalNames = null;
    try {
      await lstat(finalDirectoryPath);
      preExistingFinalNames = (await readdir(finalDirectoryPath)).sort();
    } catch {
      preExistingFinalNames = null;
    }
    if (preExistingFinalNames === null) {
      await verifyDirectory(handles.loaderDirectory);
      await mkdir(finalDirectoryPath, { mode: 0o700 });
    } else {
      if (preExistingFinalNames.some((name) => !allowedPreExisting.has(name))) {
        fail("native final directory contains stale or unknown entries");
      }
      for (const name of preExistingFinalNames) {
        let status;
        try {
          status = await lstat(join(finalDirectoryPath, name));
        } catch {
          fail("native final directory entry cannot be inspected");
        }
        if (!status.isFile() || status.isSymbolicLink()) {
          fail("native final directory entry is not a regular sibling artifact");
        }
      }
    }
    created.finalDirectory = {
      path: finalDirectoryPath,
      purpose: "native final directory",
      identity: undefined,
      handle: undefined,
    };
    created.finalDirectory = await inspectDirectory(
      finalDirectoryPath,
      "native final directory",
      true,
    );
    created.finalDirectory.preExistingNames = preExistingFinalNames;
    await verifyDirectory(handles.loaderDirectory);

    await verifyDirectory(handles.loaderDirectory);
    const temporaryDirectoryPath = await mkdtemp(
      join(loaderDirectoryPath, `.relay-v2-native-stage-${process.pid}-${randomUUID()}-`),
    );
    created.temporaryDirectory = {
      path: temporaryDirectoryPath,
      purpose: "private native staging directory",
      identity: undefined,
      handle: undefined,
    };
    created.temporaryDirectory = await inspectDirectory(
      temporaryDirectoryPath,
      "private native staging directory",
      true,
    );
    await verifyDirectory(handles.loaderDirectory);

    const temporaryPath = join(created.temporaryDirectory.path, "artifact.tmp");
    await verifyDirectory(created.temporaryDirectory);
    handles.temporary = {
      purpose: "native staging temporary",
      handle: await open(
        temporaryPath,
        fsConstants.O_RDWR
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW
          | fsConstants.O_CLOEXEC,
        0o600,
      ),
    };
    created.temporaryFile = {
      path: temporaryPath,
      purpose: "native staging temporary",
      identity: undefined,
    };
    const temporaryStatus = await handles.temporary.handle.stat();
    if (!temporaryStatus.isFile()) fail("native staging temporary is not regular");
    handles.temporary.identity = identity(temporaryStatus);
    created.temporaryFile.identity = handles.temporary.identity;
    await verifyDirectory(created.temporaryDirectory);
    await verifyLeaf(
      temporaryPath,
      created.temporaryFile.identity,
      "native staging temporary",
    );

    await copyBetweenHandles(
      handles.source.handle,
      handles.temporary.handle,
      handles.source.status.size,
    );
    await handles.temporary.handle.sync();
    const copiedStatus = await handles.temporary.handle.stat();
    if (
      !copiedStatus.isFile()
      || !sameIdentity(copiedStatus, created.temporaryFile.identity)
      || copiedStatus.size !== handles.source.status.size
    ) {
      fail("native staging temporary size or identity is invalid");
    }
    verifyHeader(await readHeaderFromHandle(handles.temporary.handle));
    const sourceDigest = await digestHandle(
      handles.source.handle,
      handles.source.status.size,
    );
    const stagedDigest = await digestHandle(
      handles.temporary.handle,
      copiedStatus.size,
    );
    if (sourceDigest !== stagedDigest) {
      fail("staged native artifact does not match the Cargo artifact");
    }
    const sourceAfter = await handles.source.handle.stat();
    if (
      !sameIdentity(sourceAfter, handles.source.identity)
      || sourceAfter.size !== handles.source.status.size
    ) {
      fail("Cargo native artifact changed during staging");
    }

    await verifyDirectory(handles.loaderDirectory);
    await verifyDirectory(created.finalDirectory);
    await verifyDirectory(created.temporaryDirectory);
    await verifyLeaf(
      temporaryPath,
      created.temporaryFile.identity,
      "native staging temporary",
    );
    const finalNames = (await readdir(created.finalDirectory.path)).sort();
    const temporaryNames = await readdir(created.temporaryDirectory.path);
    const expectedPreExisting = created.finalDirectory.preExistingNames;
    if (expectedPreExisting === null || expectedPreExisting === undefined) {
      if (finalNames.length !== 0) {
        fail("native final directory is not empty before publication");
      }
    } else if (
      finalNames.length !== expectedPreExisting.length
      || finalNames.some((name, index) => name !== expectedPreExisting[index])
    ) {
      fail("native final directory contents changed before publication");
    }
    if (temporaryNames.length !== 1 || temporaryNames[0] !== basename(temporaryPath)) {
      fail("private native staging directory contains an unknown entry");
    }

    await link(temporaryPath, finalPath);
    committed = true;

    const postCommitFailures = [];
    for (const parent of [
      handles.loaderDirectory,
      created.finalDirectory,
      created.temporaryDirectory,
    ]) {
      try {
        await verifyDirectory(parent);
      } catch (error) {
        postCommitFailures.push(safeStageMessage(error));
      }
    }
    const cleanupFailures = await cleanupAfterCommit(created, handles);
    postCommitFailures.push(...cleanupFailures);
    if (postCommitFailures.length > 0) {
      throw new FdOwnedNativeStageError(
        `native artifact commit was preserved; post-commit identity/temporary cleanup failed: ${postCommitFailures.join("; ")}`,
      );
    }
    return Object.freeze({ path: finalPath });
  } catch (error) {
    primaryError = error;
  }

  if (committed) throw primaryError;
  const cleanupFailures = await cleanupBeforeCommit(created, handles);
  if (cleanupFailures.length > 0) {
    throw new FdOwnedNativeStageError(
      `${safeStageMessage(primaryError)}; cleanup also failed: ${cleanupFailures.join("; ")}`,
    );
  }
  throw primaryError;
}
