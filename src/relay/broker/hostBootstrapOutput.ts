import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const OUTPUT_ERROR = "Relay v2 host bootstrap output failed";
const OUTPUT_MAX_BYTES = 8_193;
const OUTPUT_MODE = 0o600n;

function outputError(): Error {
  return new Error(OUTPUT_ERROR);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function fsyncDirectory(path: string): void {
  let fd = -1;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

type FileObservation = BigIntStats;

function currentOwner(): bigint {
  if (typeof process.geteuid !== "function") throw outputError();
  return BigInt(process.geteuid());
}

function isExactPrivateFile(
  observation: FileObservation,
  expectedOwner: bigint,
  expectedSize?: bigint,
): boolean {
  return (
    observation.isFile()
    && observation.uid === expectedOwner
    && observation.nlink === 1n
    && (observation.mode & 0o7777n) === OUTPUT_MODE
    && observation.size > 0n
    && observation.size <= BigInt(OUTPUT_MAX_BYTES)
    && (expectedSize === undefined || observation.size === expectedSize)
  );
}

function sameFileObservation(
  left: FileObservation,
  right: FileObservation,
): boolean {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function canonicalOutputBytes(secret: string): Buffer {
  const match = /^twhostboot2\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(secret);
  if (match === null) throw outputError();
  const selector = Buffer.from(match[1]!, "base64url");
  const tokenSecret = Buffer.from(match[2]!, "base64url");
  if (
    selector.byteLength !== 16
    || tokenSecret.byteLength !== 32
    || selector.toString("base64url") !== match[1]
    || tokenSecret.toString("base64url") !== match[2]
  ) {
    throw outputError();
  }
  const output = Buffer.from(`${secret}\n`, "utf8");
  if (output.byteLength === 0 || output.byteLength > OUTPUT_MAX_BYTES) {
    throw outputError();
  }
  return output;
}

function openReadOnlyNoFollow(path: string): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw outputError();
  return openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
}

function readExact(fd: number, size: number): Buffer {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < contents.byteLength) {
    const count = readSync(fd, contents, offset, contents.byteLength - offset, offset);
    if (count <= 0) throw outputError();
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(fd, extra, 0, 1, offset) !== 0) throw outputError();
  return contents;
}

function unlinkOwnedTemporary(
  path: string,
  identity: FileObservation | undefined,
): void {
  if (identity === undefined) return;
  try {
    const current = lstatSync(path, { bigint: true });
    if (
      current.isFile()
      && current.dev === identity.dev
      && current.ino === identity.ino
    ) {
      unlinkSync(path);
    }
  } catch {}
}

function verifyExistingExact(
  outputPath: string,
  expected: Buffer,
): "missing" | "exact" {
  const owner = currentOwner();
  let before: FileObservation;
  try {
    before = lstatSync(outputPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw outputError();
  }
  if (!isExactPrivateFile(before, owner, BigInt(expected.byteLength))) {
    throw outputError();
  }

  let fd = -1;
  let opened: FileObservation;
  try {
    fd = openReadOnlyNoFollow(outputPath);
    opened = fstatSync(fd, { bigint: true });
    if (
      !isExactPrivateFile(opened, owner, BigInt(expected.byteLength))
      || !sameFileObservation(before, opened)
    ) {
      throw outputError();
    }
    const contents = readExact(fd, expected.byteLength);
    if (!contents.equals(expected)) throw outputError();
    fsyncSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    if (
      !isExactPrivateFile(afterRead, owner, BigInt(expected.byteLength))
      || !sameFileObservation(opened, afterRead)
    ) {
      throw outputError();
    }
    const afterPath = lstatSync(outputPath, { bigint: true });
    if (!sameFileObservation(afterRead, afterPath)) throw outputError();
    opened = afterRead;
  } finally {
    if (fd >= 0) closeSync(fd);
  }

  fsyncDirectory(dirname(outputPath));
  const finalPath = lstatSync(outputPath, { bigint: true });
  if (
    !isExactPrivateFile(finalPath, owner, BigInt(expected.byteLength))
    || !sameFileObservation(opened, finalPath)
  ) {
    throw outputError();
  }
  return "exact";
}

/**
 * Returns the synchronous restricted sink required by the shipping root admin
 * port. A missing target is atomically created through a fully durable
 * same-directory 0600 temporary file and a no-clobber hard-link installation.
 * An existing target is accepted only when its fd-bound identity and exact
 * canonical bytes remain stable. Failures never include the secret or path.
 */
export function createRelayV2HostBootstrapOutputSink(
  outputPath: string,
): (secret: string) => void {
  if (outputPath.length === 0 || outputPath.includes("\0") || basename(outputPath).length === 0) {
    throw outputError();
  }

  return (secret: string): void => {
    const contents = canonicalOutputBytes(secret);
    if (verifyExistingExact(outputPath, contents) === "exact") return;

    const directory = dirname(outputPath);
    const temporary = join(
      directory,
      `.${basename(outputPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let fd = -1;
    let temporaryIdentity: FileObservation | undefined;
    try {
      if (typeof fsConstants.O_NOFOLLOW !== "number") throw outputError();
      fd = openSync(
        temporary,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(fd, 0o600);
      const initial = fstatSync(fd, { bigint: true });
      temporaryIdentity = initial;
      if (
        !initial.isFile()
        || initial.uid !== currentOwner()
        || initial.nlink !== 1n
        || (initial.mode & 0o7777n) !== OUTPUT_MODE
        || initial.size !== 0n
      ) {
        throw outputError();
      }
      let offset = 0;
      while (offset < contents.byteLength) {
        const written = writeSync(fd, contents, offset, contents.byteLength - offset, offset);
        if (written <= 0) throw outputError();
        offset += written;
      }
      fsyncSync(fd);
      const complete = fstatSync(fd, { bigint: true });
      if (
        !complete.isFile()
        || complete.dev !== initial.dev
        || complete.ino !== initial.ino
        || complete.uid !== initial.uid
        || complete.gid !== initial.gid
        || complete.nlink !== 1n
        || (complete.mode & 0o7777n) !== OUTPUT_MODE
        || complete.size !== BigInt(contents.byteLength)
      ) {
        throw outputError();
      }
      closeSync(fd);
      fd = -1;
      linkSync(temporary, outputPath);
      unlinkSync(temporary);
      temporaryIdentity = undefined;
      fsyncDirectory(directory);
      if (verifyExistingExact(outputPath, contents) !== "exact") {
        throw outputError();
      }
    } catch {
      throw outputError();
    } finally {
      if (fd >= 0) {
        try { closeSync(fd); } catch {}
      }
      unlinkOwnedTemporary(temporary, temporaryIdentity);
    }
  };
}
