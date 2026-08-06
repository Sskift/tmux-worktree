import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
  type RelayV2HostCredentialAtomicByteCellCasResult,
  type RelayV2HostCredentialAtomicByteCellRead,
  type RelayV2HostCredentialAtomicByteCellRevision,
  type RelayV2HostCredentialAtomicByteCellTransaction,
} from "./hostCredentialVault.js";
import type {
  RelayV2HostCredentialAtomicByteCellOwner,
} from "./hostPrivilegedProductionIntakeComposition.js";

const promisePrototypeThen = Promise.prototype.then;

/**
 * Contract-fixed native Host credential atomic-file-cell resource names and
 * limits (host-credential-atomic-file-cell-v1, contract revision 7). The
 * credential file stores the raw vault envelope bytes; the native lock and
 * claim sidecars belong to the deleted native admission protocol and are not
 * created here.
 */
export const RELAY_V2_HOST_CREDENTIAL_FILE_CELL_MAX_BYTES = 65_536 as const;
const CREDENTIAL_NAME = "relay-v2-host-credential.cell" as const;
const TEMPORARY_PREFIX = ".relay-v2-host-credential.cell.tmp-" as const;
const TEMPORARY_ENTROPY_BYTES = 32 as const;
const JS_LOCK_NAME = ".relay-v2-host-credential.cell.js-lock-v1" as const;
const JS_LOCK_OWNER_NAME = "owner" as const;
const JS_LOCK_STALE_MS = 30_000 as const;
const JS_LOCK_ACQUIRE_ATTEMPTS = 2 as const;
const CELL_DIRECTORY_COMPONENTS = Object.freeze([
  ".tmux-worktree",
  "relay-v2-host-credential-atomic-file-cell-v1",
] as const);

/** Full path of the native-format credential cell file beneath a home. */
export function relayV2HostCredentialFileCellPath(trustedHome: string): string {
  return join(trustedHome, ...CELL_DIRECTORY_COMPONENTS, CREDENTIAL_NAME);
}

function cellDirectoryPath(trustedHome: string): string {
  return join(trustedHome, ...CELL_DIRECTORY_COMPONENTS);
}

export type RelayV2HostCredentialFileCellErrorCode =
  | "OPERATION_INVALID"
  | "REVISION_INVALID"
  | "REPLACEMENT_INVALID"
  | "REENTRANT"
  | "ASYNC_OPERATION_UNSUPPORTED"
  | "CLOSED"
  | "CELL_BUSY"
  | "CELL_CORRUPT"
  | "CELL_PERMISSION_INVALID"
  | "CELL_IDENTITY_UNCERTAIN"
  | "CELL_IO";

const ERROR_MESSAGES: Readonly<Record<
RelayV2HostCredentialFileCellErrorCode,
string
>> = Object.freeze({
  OPERATION_INVALID: "Relay v2 Host credential file cell operation is invalid",
  REVISION_INVALID: "Relay v2 Host credential file cell revision is invalid",
  REPLACEMENT_INVALID: "Relay v2 Host credential file cell replacement is invalid",
  REENTRANT: "Relay v2 Host credential file cell rejects reentrant access",
  ASYNC_OPERATION_UNSUPPORTED:
    "Relay v2 Host credential file cell operation must be synchronous",
  CLOSED: "Relay v2 Host credential file cell is closed",
  CELL_BUSY: "Relay v2 Host credential file cell is busy in another process",
  CELL_CORRUPT: "Relay v2 Host credential file cell is corrupt",
  CELL_PERMISSION_INVALID: "Relay v2 Host credential file cell permission is invalid",
  CELL_IDENTITY_UNCERTAIN:
    "Relay v2 Host credential file cell identity is uncertain",
  CELL_IO: "Relay v2 Host credential file cell I/O failed",
});

export class RelayV2HostCredentialFileCellError extends Error {
  constructor(readonly code: RelayV2HostCredentialFileCellErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RelayV2HostCredentialFileCellError";
  }
}

interface RevisionRecord {
  readonly owner: object;
  readonly generation: number;
  /** SHA-256 of the observed credential bytes; null when the cell was absent. */
  readonly digest: Uint8Array | null;
  /** `dev:ino` of the observed credential file; null when the cell was absent. */
  readonly identity: string | null;
  consumed: boolean;
}

interface FileSnapshot {
  readonly bytes: Uint8Array;
  readonly digest: Uint8Array;
  readonly identity: string;
}

function failure(
  code: RelayV2HostCredentialFileCellErrorCode,
): RelayV2HostCredentialFileCellError {
  return new RelayV2HostCredentialFileCellError(code);
}

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeTypes.isProxy(value);
  } catch {
    return true;
  }
}

function copyReplacement(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)
    || rejectedProxy(value)
    || value.byteLength > RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES) {
    throw failure("REPLACEMENT_INVALID");
  }
  return Uint8Array.from(value);
}

function isAsynchronousResultWithoutAssimilation(value: unknown): boolean {
  if (nodeTypes.isPromise(value)) {
    try {
      void promisePrototypeThen.call(value, undefined, () => undefined);
    } catch {
      return true;
    }
    return true;
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  let current: object | null = value as object;
  try {
    while (current !== null) {
      if (nodeTypes.isProxy(current)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(current, "then");
      if (descriptor !== undefined) {
        return descriptor.get !== undefined || typeof descriptor.value === "function";
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Provenance result for the credential cell directory chain. `missing` means
 * some component does not exist yet (there is simply no credential to read);
 * every unsafe shape (symlink, foreign owner, wrong mode) fails closed.
 */
type DirectoryProof =
  | { readonly kind: "ready" }
  | { readonly kind: "missing" };

function requireTrustedHomeShape(trustedHome: string): void {
  if (typeof trustedHome !== "string"
    || trustedHome.length === 0
    || trustedHome.includes("\0")
    || !isAbsolute(trustedHome)
    || process.platform !== "darwin" && process.platform !== "linux"
    || typeof process.geteuid !== "function"
    || typeof process.getegid !== "function") {
    throw failure("CELL_PERMISSION_INVALID");
  }
}

function proofDirectoryComponent(
  path: string,
  expectedMode: number,
  requireGid: boolean,
  missing: () => boolean,
): boolean {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT" && missing()) return false;
    throw failure("CELL_IO");
  }
  if (before.isSymbolicLink()
    || !before.isDirectory()
    || before.uid !== BigInt(process.geteuid())
    || requireGid && before.gid !== BigInt(process.getegid())
    || (before.mode & 0o7777n) !== BigInt(expectedMode)) {
    throw failure("CELL_PERMISSION_INVALID");
  }
  return true;
}

function proofCellDirectory(trustedHome: string): DirectoryProof {
  requireTrustedHomeShape(trustedHome);
  const canonicalHome = realpathSync.native(trustedHome);
  if (canonicalHome !== trustedHome) throw failure("CELL_IDENTITY_UNCERTAIN");
  // The home itself must be an owned directory without group/other write
  // (native validate_home: owner_uid == euid and mode & 0o022 == 0). The
  // derived components must be exactly 0700 and owned by euid/egid.
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(canonicalHome, { bigint: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { kind: "missing" };
    throw failure("CELL_IO");
  }
  if (before.isSymbolicLink()
    || !before.isDirectory()
    || before.uid !== BigInt(process.geteuid())
    || (before.mode & 0o022n) !== 0n) {
    throw failure("CELL_PERMISSION_INVALID");
  }

  let current = canonicalHome;
  for (const component of CELL_DIRECTORY_COMPONENTS) {
    current = join(current, component);
    const present = proofDirectoryComponent(
      current,
      0o700,
      true,
      () => true,
    );
    if (!present) return { kind: "missing" };
  }
  return { kind: "ready" };
}

function readExactly(descriptor: number, length: number): Uint8Array {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, offset);
    if (count <= 0) throw failure("CELL_IO");
    offset += count;
  }
  return Uint8Array.from(bytes);
}

/**
 * Read the exact credential file through a no-follow open and prove the
 * native file invariants: regular, nlink 1, owned by euid/egid, 0600, and at
 * most CREDENTIAL_MAXIMUM_BYTES. A missing credential file (or a missing cell
 * directory) is the empty-cell state, never an error.
 */
function readCredentialSnapshot(directory: string): FileSnapshot | null {
  const path = join(directory, CREDENTIAL_NAME);
  let descriptor = -1;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.nlink !== 1n
      || opened.uid !== BigInt(process.geteuid())
      || opened.gid !== BigInt(process.getegid())
      || (opened.mode & 0o7777n) !== 0o600n) {
      throw failure("CELL_PERMISSION_INVALID");
    }
    if (opened.size > BigInt(RELAY_V2_HOST_CREDENTIAL_FILE_CELL_MAX_BYTES)) {
      throw failure("CELL_CORRUPT");
    }
    const bytes = readExactly(descriptor, Number(opened.size));
    return {
      bytes,
      digest: Uint8Array.from(createHash("sha256").update(bytes).digest()),
      identity: `${opened.dev}:${opened.ino}`,
    };
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    if (error instanceof RelayV2HostCredentialFileCellError) throw error;
    throw failure("CELL_IO");
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        throw failure("CELL_IO");
      }
    }
  }
}

function lockDirectoryPath(directory: string): string {
  return join(directory, JS_LOCK_NAME);
}

function readLockOwner(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(path, JS_LOCK_OWNER_NAME), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function lockIsStale(path: string): boolean {
  const owner = readLockOwner(path);
  if (owner !== null) {
    if (typeof owner.pid === "number"
      && typeof owner.createdAt === "number"
      && Number.isFinite(owner.createdAt)) {
      return Date.now() - owner.createdAt > JS_LOCK_STALE_MS
        && !processExists(owner.pid);
    }
    return true;
  }
  try {
    return Date.now() - statSync(path).mtimeMs > JS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function discardStaleLock(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    throw failure("CELL_IO");
  }
}

/**
 * Best-effort cross-process exclusion, acquired around a compare-and-swap
 * only. Node has no F_SETLK, so this is the wx-exclusive-owner approximation
 * the repository already uses for the host-state store: an owner directory
 * with a pid/createdAt record and stale recovery. The native crate instead
 * holds a persistent lock file locked with nonblocking F_SETLK for the whole
 * session; the JS cell cannot participate in that protocol, so it uses its own
 * lock namespace and leaves the native lock/claim sidecars untouched. A stale
 * lock from a dead process is reclaimed; a fresh foreign lock fails closed
 * with CELL_BUSY. Returns false when the lock could not be acquired.
 */
function acquireCellLock(directory: string): boolean {
  const lockPath = lockDirectoryPath(directory);
  for (let attempt = 0; attempt < JS_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw failure("CELL_IO");
      if (!lockIsStale(lockPath)) return false;
      discardStaleLock(lockPath);
      continue;
    }
    const owner = {
      owner: `${process.pid}-${randomUUID()}`,
      pid: process.pid,
      createdAt: Date.now(),
    };
    try {
      writeFileSync(
        join(lockPath, JS_LOCK_OWNER_NAME),
        `${JSON.stringify(owner)}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      discardStaleLock(lockPath);
      if (errnoOf(error) === "EEXIST") continue;
      throw failure("CELL_IO");
    }
    return true;
  }
  return false;
}

function releaseCellLock(directory: string): void {
  const lockPath = lockDirectoryPath(directory);
  const owner = readLockOwner(lockPath);
  if (owner === null) return;
  if (typeof owner.pid === "number" && owner.pid !== process.pid) return;
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Close must not throw; a stale lock is recovered on the next attempt.
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor = -1;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    throw failure("CELL_IO");
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        throw failure("CELL_IO");
      }
    }
  }
}

/**
 * Atomic same-directory publication matching the native mutation protocol:
 * exclusive temp create (0600), exact write, fsync temp, rename over the
 * credential, fsync directory. Any failure removes the temp and leaves the
 * previous credential untouched.
 */
function atomicWriteCredential(directory: string, replacement: Uint8Array): void {
  const temporary = join(
    directory,
    `${TEMPORARY_PREFIX}${randomBytes(TEMPORARY_ENTROPY_BYTES).toString("hex")}`,
  );
  let descriptor = -1;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < replacement.byteLength) {
      offset += writeSync(
        descriptor,
        Buffer.from(replacement.buffer, replacement.byteOffset, replacement.byteLength),
        offset,
        replacement.byteLength - offset,
        offset,
      );
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    renameSync(temporary, join(directory, CREDENTIAL_NAME));
    fsyncDirectory(directory);
  } catch (error) {
    throw failure("CELL_IO");
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        // Best-effort cleanup after a failed write.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; a leftover temp is inert and unique.
    }
  }
}

/**
 * Process-local, file-backed atomic cell that reads and writes the exact
 * native-format credential cell under a proven home. It implements the
 * Vault's narrow synchronous cell port: a read snapshots the current file
 * state, and a compare-and-swap re-proves that state, then publishes through
 * an exclusive temp + fsync + rename. The cell never creates directories or
 * sidecars (deployment pre-creates the fixed 0700 namespace); a missing
 * credential is the empty-cell state, not an error.
 */
export function createRelayV2HostCredentialFileCell(
  trustedHome: string,
): RelayV2HostCredentialAtomicByteCellOwner {
  requireTrustedHomeShape(trustedHome);
  const owner = Object.freeze(Object.create(null));
  const revisions = new WeakMap<object, RevisionRecord>();
  let generation = 0;
  let lifecycle: "open" | "closed" = "open";
  let active = false;
  let closePromise: Promise<void> | null = null;

  const directory = cellDirectoryPath(trustedHome);

  const requireOperationOpen = (): void => {
    if (lifecycle !== "open") throw failure("CLOSED");
    if (!active) throw failure("OPERATION_INVALID");
  };

  const issueRevision = (snapshot: FileSnapshot | null): Readonly<{
    bytes: Uint8Array | null;
    revision: RelayV2HostCredentialAtomicByteCellRevision;
  }> => {
    const revision = Object.freeze(Object.create(null));
    revisions.set(revision, {
      owner,
      generation,
      digest: snapshot === null ? null : Uint8Array.from(snapshot.digest),
      identity: snapshot === null ? null : snapshot.identity,
      consumed: false,
    });
    return Object.freeze({
      bytes: snapshot === null ? null : Uint8Array.from(snapshot.bytes),
      revision,
    });
  };

  const readCurrent = (): Readonly<{
    bytes: Uint8Array | null;
    revision: RelayV2HostCredentialAtomicByteCellRevision;
  }> => issueRevision(readCredentialSnapshot(directory));

  const read = (): RelayV2HostCredentialAtomicByteCellRead => {
    requireOperationOpen();
    const proof = proofCellDirectory(trustedHome);
    if (proof.kind === "missing") return issueRevision(null);
    return readCurrent();
  };

  const snapshotMatchesRevision = (
    snapshot: FileSnapshot | null,
    record: RevisionRecord,
  ): boolean => {
    if (snapshot === null) return record.digest === null && record.identity === null;
    if (record.digest === null || record.identity === null) return false;
    return snapshot.identity === record.identity
      && snapshot.digest.byteLength === record.digest.byteLength
      && snapshot.digest.every((byte, index) => byte === record.digest[index]);
  };

  const compareAndSwap = (
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    replacement: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult => {
    requireOperationOpen();
    if (expected === null || typeof expected !== "object" || rejectedProxy(expected)) {
      throw failure("REVISION_INVALID");
    }
    const record = revisions.get(expected as object);
    if (record === undefined || record.owner !== owner || record.consumed) {
      throw failure("REVISION_INVALID");
    }
    record.consumed = true;
    const copied = copyReplacement(replacement);
    if (record.generation !== generation) {
      return Object.freeze({ status: "conflict", current: read() });
    }

    const proof = proofCellDirectory(trustedHome);
    if (proof.kind === "missing") {
      throw failure("CELL_IO");
    }
    const initial = readCredentialSnapshot(directory);
    if (!snapshotMatchesRevision(initial, record)) {
      return Object.freeze({ status: "conflict", current: readCurrent() });
    }

    if (!acquireCellLock(directory)) throw failure("CELL_BUSY");
    let locked = true;
    try {
      const rechecked = readCredentialSnapshot(directory);
      if (!snapshotMatchesRevision(rechecked, record)) {
        return Object.freeze({ status: "conflict", current: readCurrent() });
      }
      atomicWriteCredential(directory, copied);
      generation += 1;
      return Object.freeze({ status: "swapped" });
    } finally {
      if (locked) releaseCellLock(directory);
    }
  };

  const transaction = Object.freeze(Object.assign(Object.create(null), {
    read,
    compareAndSwap,
  })) as RelayV2HostCredentialAtomicByteCellTransaction;

  const runExclusive = <T>(
    operation: (value: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T => {
    if (lifecycle !== "open") throw failure("CLOSED");
    if (active) throw failure("REENTRANT");
    if (typeof operation !== "function"
      || rejectedProxy(operation)
      || nodeTypes.isAsyncFunction(operation)) throw failure("OPERATION_INVALID");
    active = true;
    try {
      const result = Reflect.apply(operation, undefined, [transaction]) as T;
      if (isAsynchronousResultWithoutAssimilation(result)) {
        throw failure("ASYNC_OPERATION_UNSUPPORTED");
      }
      return result;
    } finally {
      active = false;
    }
  };

  const closeAndDrain = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    lifecycle = "closed";
    releaseCellLock(directory);
    closePromise = Promise.resolve();
    return closePromise;
  };

  return Object.freeze(Object.assign(Object.create(null), {
    runExclusive,
    closeAndDrain,
  })) as RelayV2HostCredentialAtomicByteCellOwner;
}
