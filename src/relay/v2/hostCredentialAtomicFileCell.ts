import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
  type RelayV2HostCredentialAtomicByteCell,
  type RelayV2HostCredentialAtomicByteCellCasResult,
  type RelayV2HostCredentialAtomicByteCellRead,
  type RelayV2HostCredentialAtomicByteCellRevision,
  type RelayV2HostCredentialAtomicByteCellTransaction,
} from "./hostCredentialVault.js";

export const RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_FILENAME =
  "relay-v2-host-credential.cell" as const;
export const RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLAIM_NAME =
  ".relay-v2-host-credential.cell.claim" as const;

const CLAIM_OWNER_FILENAME = "owner-token";
const TEMPORARY_PREFIX = ".relay-v2-host-credential.cell.tmp-";
const OWNER_TOKEN_BYTES = 32;
const MAX_OWNER_TOKEN_FILE_BYTES = 128;
const promisePrototypeThen = Promise.prototype.then;

type JsonObject = Record<string, unknown>;
type Lifecycle = "open" | "closing" | "fenced" | "recovery-required" | "closed";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnedFileIdentity extends FileIdentity {
  readonly size: bigint;
}

interface CurrentCut {
  readonly bytes: Uint8Array | null;
  readonly digest: string;
  readonly identity: OwnedFileIdentity | null;
}

interface ClaimRecord {
  readonly identity: FileIdentity;
  tokenIdentity: OwnedFileIdentity | null;
}

interface TemporaryRecord {
  readonly path: string;
  readonly identity: OwnedFileIdentity;
}

interface RevisionRecord {
  readonly owner: AtomicFileCellOwner;
  readonly generation: bigint;
  readonly digest: string;
}

/** Trusted synchronous test-only fault seam. Production callers omit it. */
export interface RelayV2HostCredentialAtomicFileCellTrustedSynchronousTestOnlySyscalls {
  readonly renameFile?: (source: string, destination: string) => undefined;
  readonly fsyncDirectory?: (directory: string) => undefined;
}

export interface RelayV2HostCredentialAtomicFileCellOptions {
  readonly directory: string;
  readonly syscalls?: RelayV2HostCredentialAtomicFileCellTrustedSynchronousTestOnlySyscalls;
}

export interface RelayV2HostCredentialAtomicFileCell
extends RelayV2HostCredentialAtomicByteCell {
  closeAndDrain(): Promise<void>;
}

export type RelayV2HostCredentialAtomicFileCellErrorCode =
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_REENTRANT"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED"
  | "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLOSED";

export class RelayV2HostCredentialAtomicFileCellError extends Error {
  constructor(readonly code: RelayV2HostCredentialAtomicFileCellErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2HostCredentialAtomicFileCellError";
  }
}

const revisions = new WeakMap<object, RevisionRecord>();

function messageForCode(code: RelayV2HostCredentialAtomicFileCellErrorCode): string {
  switch (code) {
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS":
      return "Relay v2 host credential atomic file cell options are invalid";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID":
      return "Relay v2 host credential atomic file cell directory is invalid";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID":
      return "Relay v2 host credential atomic file cell data is invalid";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED":
      return "Relay v2 host credential atomic file cell requires explicit recovery";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_REENTRANT":
      return "Relay v2 host credential atomic file cell rejects reentrant access";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED":
      return "Relay v2 host credential atomic file cell operation must be synchronous";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE":
      return "Relay v2 host credential atomic file cell I/O failed";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED":
      return "Relay v2 host credential atomic file cell is fenced after an uncertain commit";
    case "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLOSED":
      return "Relay v2 host credential atomic file cell is closed";
  }
}

function fail(code: RelayV2HostCredentialAtomicFileCellErrorCode): never {
  throw new RelayV2HostCredentialAtomicFileCellError(code);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => allowed.has(field));
}

function ownDataProperty(value: JsonObject, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
  }
  return descriptor.value;
}

function currentEuid(): bigint {
  if (typeof process.geteuid !== "function") {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
  }
  return BigInt(process.geteuid());
}

function modeOf(information: BigIntStats): number {
  return Number(information.mode & 0o7777n);
}

function identityOf(information: BigIntStats): FileIdentity {
  return { dev: information.dev, ino: information.ino };
}

function ownedFileIdentityOf(information: BigIntStats): OwnedFileIdentity {
  return { ...identityOf(information), size: information.size };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function statPath(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function statDescriptor(descriptor: number): BigIntStats {
  return fstatSync(descriptor, { bigint: true });
}

function assertDirectoryStat(information: BigIntStats): void {
  if (!information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== currentEuid()
    || modeOf(information) !== 0o700) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
  }
}

function assertClaimDirectoryStat(information: BigIntStats): void {
  if (!information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== currentEuid()
    || modeOf(information) !== 0o700) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
  }
}

function assertOwnedRegularFileStat(
  information: BigIntStats,
  maximumBytes: number,
  code: RelayV2HostCredentialAtomicFileCellErrorCode,
): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== currentEuid()
    || modeOf(information) !== 0o600
    || information.nlink !== 1n
    || information.size < 0n
    || information.size > BigInt(maximumBytes)) {
    return fail(code);
  }
}

function assertCleanupOwnedRegularFileStat(
  information: BigIntStats,
  maximumBytes: number,
): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== currentEuid()
    || information.nlink !== 1n
    || information.size < 0n
    || information.size > BigInt(maximumBytes)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
  }
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (written <= 0) return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
    offset += written;
  }
}

function readExact(
  descriptor: number,
  size: number,
  code: RelayV2HostCredentialAtomicFileCellErrorCode,
): Uint8Array {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, bytes, offset, size - offset, offset);
    if (read <= 0) return fail(code);
    offset += read;
  }
  return Uint8Array.from(bytes);
}

function digestCut(bytes: Uint8Array | null): string {
  const hash = createHash("sha256");
  hash.update(bytes === null ? Buffer.from([0]) : Buffer.from([1]));
  if (bytes !== null) hash.update(bytes);
  return hash.digest("base64url");
}

function defaultFsyncDirectory(directory: string): void {
  const before = statPath(directory);
  assertDirectoryStat(before);
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY
      | fsConstants.O_DIRECTORY
      | fsConstants.O_NOFOLLOW
      | fsConstants.O_CLOEXEC,
  );
  try {
    const opened = statDescriptor(descriptor);
    assertDirectoryStat(opened);
    if (!sameIdentity(before, opened)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isNativeAsyncFunction(value: (...args: never[]) => unknown): boolean {
  try {
    return nodeUtilTypes.isAsyncFunction(value);
  } catch {
    return true;
  }
}

function isAsynchronousResultWithoutAssimilation(value: unknown): boolean {
  if (nodeUtilTypes.isPromise(value)) {
    try {
      void promisePrototypeThen.call(value, undefined, () => undefined);
    } catch {
      return true;
    }
    return true;
  }
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  let current: object | null = value as object;
  try {
    while (current !== null) {
      if (nodeUtilTypes.isProxy(current)) return true;
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

function frozenMethodPort<T extends object>(methods: Record<string, (...args: never[]) => unknown>): T {
  const port = Object.create(null) as T;
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(port, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: method,
    });
  }
  return Object.freeze(port);
}

class AtomicFileCellOwner {
  readonly #directory: string;
  readonly #directoryIdentity: FileIdentity;
  readonly #credentialPath: string;
  readonly #claimPath: string;
  readonly #claimOwnerPath: string;
  readonly #ownerToken: Buffer;
  readonly #renameFile: (source: string, destination: string) => unknown;
  readonly #fsyncDirectory: (directory: string) => unknown;
  readonly #temporaries = new Map<string, TemporaryRecord>();
  #claim: ClaimRecord | null = null;
  #claimReady = false;
  #generation = 0n;
  #lifecycle: Lifecycle = "open";
  #operationActive = false;
  #admitted = 0;
  #closePromise: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;
  #rejectClose: ((error: unknown) => void) | null = null;

  constructor(
    directory: string,
    directoryIdentity: FileIdentity,
    renameFile: (source: string, destination: string) => unknown,
    fsyncDirectory: (directory: string) => unknown,
  ) {
    this.#directory = directory;
    this.#directoryIdentity = directoryIdentity;
    this.#credentialPath = join(directory, RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_FILENAME);
    this.#claimPath = join(directory, RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLAIM_NAME);
    this.#claimOwnerPath = join(this.#claimPath, CLAIM_OWNER_FILENAME);
    this.#ownerToken = Buffer.from(`${randomBytes(OWNER_TOKEN_BYTES).toString("base64url")}\n`, "ascii");
    this.#renameFile = renameFile;
    this.#fsyncDirectory = fsyncDirectory;

    try {
      this.#acquireClaim();
      this.#readCurrent();
    } catch (error) {
      if (this.#lifecycle === "recovery-required") throw error;
      if (this.#claim !== null) {
        try {
          this.#cleanupOwnedState();
        } catch {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
        }
      }
      throw error;
    }
  }

  runExclusive<T>(
    operation: (transaction: RelayV2HostCredentialAtomicByteCellTransaction) => T,
  ): T {
    if (this.#operationActive) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_REENTRANT");
    }
    this.#assertCellOperationAllowed();
    if (typeof operation !== "function") {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
    }
    if (isNativeAsyncFunction(operation as (...args: never[]) => unknown)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED");
    }

    this.#operationActive = true;
    this.#admitted += 1;
    let transactionActive = true;
    const transaction = frozenMethodPort<RelayV2HostCredentialAtomicByteCellTransaction>({
      read: (() => {
        if (!transactionActive) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLOSED");
        }
        this.#assertCellOperationAllowed();
        return this.#issueRead(this.#readCurrent());
      }) as (...args: never[]) => unknown,
      compareAndSwap: ((expected: RelayV2HostCredentialAtomicByteCellRevision, replacement: Uint8Array) => {
        if (!transactionActive) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLOSED");
        }
        this.#assertCellOperationAllowed();
        return this.#compareAndSwap(expected, replacement);
      }) as (...args: never[]) => unknown,
    });
    try {
      const result = operation(transaction);
      if (isAsynchronousResultWithoutAssimilation(result)) {
        this.#enterRecoveryRequired();
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
      return result;
    } finally {
      transactionActive = false;
      this.#operationActive = false;
      this.#admitted -= 1;
      this.#settleCloseIfReady();
    }
  }

  closeAndDrain(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#resolveClose = resolve;
      this.#rejectClose = reject;
    });
    if (this.#lifecycle === "recovery-required") {
      this.#rejectRecoveryClose();
      return this.#closePromise;
    }
    if (this.#lifecycle !== "closed") this.#lifecycle = "closing";
    this.#settleCloseIfReady();
    return this.#closePromise;
  }

  #assertCellOperationAllowed(): void {
    if (this.#lifecycle === "fenced") {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_UNCERTAIN_FENCED");
    }
    if (this.#lifecycle === "recovery-required") {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    if (this.#lifecycle !== "open") {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_CLOSED");
    }
  }

  #assertDirectoryOwned(): void {
    let canonical: string;
    let information: BigIntStats;
    try {
      canonical = realpathSync.native(this.#directory);
      information = statPath(this.#directory);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
    }
    assertDirectoryStat(information);
    if (canonical !== this.#directory
      || !sameIdentity(identityOf(information), this.#directoryIdentity)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
    }
  }

  #fsyncDirectorySynchronously(directory: string): void {
    const result = this.#fsyncDirectory(directory);
    if (result !== undefined) {
      this.#enterRecoveryRequired();
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
  }

  #renameSynchronously(source: string, destination: string): boolean {
    const result = this.#renameFile(source, destination);
    if (result === undefined) return true;
    this.#enterRecoveryRequired();
    return false;
  }

  #acquireClaim(): void {
    this.#assertDirectoryOwned();
    try {
      mkdirSync(this.#claimPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
    }
    try {
      chmodSync(this.#claimPath, 0o700);
      const claimInformation = statPath(this.#claimPath);
      assertClaimDirectoryStat(claimInformation);
      this.#claim = { identity: identityOf(claimInformation), tokenIdentity: null };

      let descriptor = -1;
      try {
        descriptor = openSync(
          this.#claimOwnerPath,
          fsConstants.O_WRONLY
            | fsConstants.O_CREAT
            | fsConstants.O_EXCL
            | fsConstants.O_NOFOLLOW
            | fsConstants.O_CLOEXEC,
          0o600,
        );
        fchmodSync(descriptor, 0o600);
        const tokenInformation = statDescriptor(descriptor);
        assertOwnedRegularFileStat(
          tokenInformation,
          MAX_OWNER_TOKEN_FILE_BYTES,
          "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
        );
        this.#claim.tokenIdentity = ownedFileIdentityOf(tokenInformation);
        writeAll(descriptor, this.#ownerToken);
        fsyncSync(descriptor);
        const finalTokenInformation = statDescriptor(descriptor);
        assertOwnedRegularFileStat(
          finalTokenInformation,
          MAX_OWNER_TOKEN_FILE_BYTES,
          "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
        );
        if (!sameIdentity(finalTokenInformation, tokenInformation)
          || finalTokenInformation.size !== BigInt(this.#ownerToken.byteLength)) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
        }
        this.#claim.tokenIdentity = ownedFileIdentityOf(finalTokenInformation);
      } finally {
        if (descriptor >= 0) closeSync(descriptor);
      }
      this.#fsyncDirectorySynchronously(this.#claimPath);
      this.#fsyncDirectorySynchronously(this.#directory);
      this.#claimReady = true;
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAtomicFileCellError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
    }
  }

  #assertClaimOwned(): void {
    this.#assertDirectoryOwned();
    const claim = this.#claim;
    if (!this.#claimReady || claim === null || claim.tokenIdentity === null) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    let claimInformation: BigIntStats;
    try {
      claimInformation = statPath(this.#claimPath);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    assertClaimDirectoryStat(claimInformation);
    if (!sameIdentity(claim.identity, claimInformation)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    let entries: string[];
    try {
      entries = readdirSync(this.#claimPath);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    if (entries.length !== 1 || entries[0] !== CLAIM_OWNER_FILENAME) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    const token = this.#readOwnedFile(
      this.#claimOwnerPath,
      MAX_OWNER_TOKEN_FILE_BYTES,
      "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
    );
    if (!sameIdentity(token.identity, claim.tokenIdentity)
      || token.bytes.byteLength !== this.#ownerToken.byteLength
      || !timingSafeEqual(Buffer.from(token.bytes), this.#ownerToken)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
  }

  #readOwnedFile(
    path: string,
    maximumBytes: number,
    code: RelayV2HostCredentialAtomicFileCellErrorCode,
  ): { bytes: Uint8Array; identity: OwnedFileIdentity } {
    let before: BigIntStats;
    try {
      before = statPath(path);
    } catch {
      return fail(code);
    }
    assertOwnedRegularFileStat(before, maximumBytes, code);
    let descriptor = -1;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
      );
      const opened = statDescriptor(descriptor);
      assertOwnedRegularFileStat(opened, maximumBytes, code);
      if (!sameIdentity(before, opened) || before.size !== opened.size) return fail(code);
      const bytes = readExact(descriptor, Number(opened.size), code);
      const after = statDescriptor(descriptor);
      assertOwnedRegularFileStat(after, maximumBytes, code);
      if (!sameIdentity(opened, after)
        || opened.size !== after.size
        || bytes.byteLength !== Number(after.size)) return fail(code);
      return { bytes, identity: ownedFileIdentityOf(after) };
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAtomicFileCellError) throw error;
      return fail(code);
    } finally {
      if (descriptor >= 0) closeSync(descriptor);
    }
  }

  #readCurrent(): CurrentCut {
    this.#assertClaimOwned();
    let information: BigIntStats;
    try {
      information = statPath(this.#credentialPath);
    } catch (error) {
      if (isMissing(error)) {
        return { bytes: null, digest: digestCut(null), identity: null };
      }
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID");
    }
    assertOwnedRegularFileStat(
      information,
      RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
      "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
    );
    const read = this.#readOwnedFile(
      this.#credentialPath,
      RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
      "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID",
    );
    if (!sameIdentity(information, read.identity)
      || information.size !== read.identity.size) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DATA_INVALID");
    }
    return {
      bytes: read.bytes,
      digest: digestCut(read.bytes),
      identity: read.identity,
    };
  }

  #issueRead(current: CurrentCut): RelayV2HostCredentialAtomicByteCellRead {
    const revision = Object.freeze(
      Object.create(null),
    ) as RelayV2HostCredentialAtomicByteCellRevision;
    revisions.set(revision as object, {
      owner: this,
      generation: this.#generation,
      digest: current.digest,
    });
    return Object.freeze({
      bytes: current.bytes === null ? null : Uint8Array.from(current.bytes),
      revision,
    });
  }

  #conflict(current: CurrentCut): RelayV2HostCredentialAtomicByteCellCasResult {
    return Object.freeze({ status: "conflict", current: this.#issueRead(current) });
  }

  #compareAndSwap(
    expected: RelayV2HostCredentialAtomicByteCellRevision,
    rawReplacement: Uint8Array,
  ): RelayV2HostCredentialAtomicByteCellCasResult {
    this.#assertCellOperationAllowed();
    if (!(rawReplacement instanceof Uint8Array)
      || rawReplacement.byteLength > RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
    }
    const replacement = Uint8Array.from(rawReplacement);
    const current = this.#readCurrent();
    const record = typeof expected === "object" && expected !== null
      ? revisions.get(expected as object)
      : undefined;
    if (!record
      || record.owner !== this
      || record.generation !== this.#generation
      || record.digest !== current.digest) {
      return this.#conflict(current);
    }

    const temporary = this.#createTemporary(replacement);
    let committed = false;
    try {
      this.#assertClaimOwned();
      const beforeCommit = this.#readCurrent();
      if (record.generation !== this.#generation || record.digest !== beforeCommit.digest) {
        this.#cleanupTemporary(temporary, false);
        return this.#conflict(beforeCommit);
      }
      this.#assertTemporaryOwned(temporary);
      try {
        if (!this.#renameSynchronously(temporary.path, this.#credentialPath)) {
          return Object.freeze({ status: "uncertain" });
        }
      } catch {
        if (this.#temporaryStillOwned(temporary)) {
          this.#cleanupTemporary(temporary, false);
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
        }
        this.#temporaries.delete(temporary.path);
        this.#fenceUncertain();
        return Object.freeze({ status: "uncertain" });
      }
      committed = true;
      this.#temporaries.delete(temporary.path);
      this.#generation += 1n;

      try {
        this.#assertClaimOwned();
        const published = this.#readCurrent();
        if (published.identity === null
          || !sameIdentity(published.identity, temporary.identity)
          || published.digest !== digestCut(replacement)) {
          throw new Error("published identity mismatch");
        }
        this.#assertDirectoryOwned();
        this.#fsyncDirectorySynchronously(this.#directory);
        return Object.freeze({ status: "swapped" });
      } catch {
        this.#fenceUncertain();
        return Object.freeze({ status: "uncertain" });
      }
    } catch (error) {
      if (!committed && this.#temporaries.has(temporary.path)) {
        try {
          this.#cleanupTemporary(temporary, false);
        } catch {
          this.#lifecycle = "fenced";
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
        }
      }
      throw error;
    }
  }

  #createTemporary(bytes: Uint8Array): TemporaryRecord {
    this.#assertClaimOwned();
    const path = join(this.#directory, `${TEMPORARY_PREFIX}${randomBytes(18).toString("hex")}`);
    let descriptor = -1;
    let record: TemporaryRecord | null = null;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW
          | fsConstants.O_CLOEXEC,
        0o600,
      );
      const created = statDescriptor(descriptor);
      assertCleanupOwnedRegularFileStat(
        created,
        RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
      );
      record = { path, identity: ownedFileIdentityOf(created) };
      this.#temporaries.set(path, record);
      fchmodSync(descriptor, 0o600);
      const protectedFile = statDescriptor(descriptor);
      assertOwnedRegularFileStat(
        protectedFile,
        RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
        "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE",
      );
      if (!sameIdentity(created, protectedFile) || protectedFile.size !== 0n) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
      }
      writeAll(descriptor, bytes);
      fsyncSync(descriptor);
      const complete = statDescriptor(descriptor);
      assertOwnedRegularFileStat(
        complete,
        RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
        "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE",
      );
      if (!sameIdentity(created, complete) || complete.size !== BigInt(bytes.byteLength)) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
      }
      record = { path, identity: ownedFileIdentityOf(complete) };
      this.#temporaries.set(path, record);
      return record;
    } catch (error) {
      if (record !== null) {
        try {
          this.#cleanupTemporary(record, false);
        } catch {
          this.#lifecycle = "fenced";
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
        }
      }
      if (error instanceof RelayV2HostCredentialAtomicFileCellError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_IO_FAILURE");
    } finally {
      if (descriptor >= 0) closeSync(descriptor);
    }
  }

  #assertTemporaryOwned(record: TemporaryRecord): void {
    let information: BigIntStats;
    try {
      information = statPath(record.path);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    assertOwnedRegularFileStat(
      information,
      RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
      "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
    );
    if (!sameIdentity(information, record.identity)
      || information.size !== record.identity.size) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
  }

  #temporaryStillOwned(record: TemporaryRecord): boolean {
    try {
      this.#assertTemporaryOwned(record);
      return true;
    } catch {
      return false;
    }
  }

  #cleanupTemporary(record: TemporaryRecord, allowMissing: boolean): void {
    let information: BigIntStats;
    try {
      information = statPath(record.path);
    } catch (error) {
      if (allowMissing && isMissing(error)) {
        this.#temporaries.delete(record.path);
        return;
      }
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    assertCleanupOwnedRegularFileStat(
      information,
      RELAY_V2_HOST_CREDENTIAL_VAULT_MAX_ENVELOPE_BYTES,
    );
    if (!sameIdentity(information, record.identity)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    try {
      unlinkSync(record.path);
      this.#temporaries.delete(record.path);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
  }

  #cleanupOwnedState(): void {
    this.#assertDirectoryOwned();
    for (const temporary of [...this.#temporaries.values()]) {
      this.#cleanupTemporary(temporary, false);
    }
    const claim = this.#claim;
    if (claim === null) return;
    let claimInformation: BigIntStats;
    try {
      claimInformation = statPath(this.#claimPath);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    assertClaimDirectoryStat(claimInformation);
    if (!sameIdentity(claimInformation, claim.identity)) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    let entries: string[];
    try {
      entries = readdirSync(this.#claimPath);
    } catch {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
    if (claim.tokenIdentity === null) {
      if (entries.length !== 0) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
    } else {
      if (entries.length !== 1 || entries[0] !== CLAIM_OWNER_FILENAME) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
      const token = this.#readOwnedFile(
        this.#claimOwnerPath,
        MAX_OWNER_TOKEN_FILE_BYTES,
        "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
      );
      if (!sameIdentity(token.identity, claim.tokenIdentity)
        || token.bytes.byteLength !== this.#ownerToken.byteLength
        || !timingSafeEqual(Buffer.from(token.bytes), this.#ownerToken)) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
      try {
        const beforeUnlink = statPath(this.#claimOwnerPath);
        if (!sameIdentity(beforeUnlink, claim.tokenIdentity)) {
          return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
        }
        unlinkSync(this.#claimOwnerPath);
      } catch (error) {
        if (error instanceof RelayV2HostCredentialAtomicFileCellError) throw error;
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
    }
    try {
      const beforeRemove = statPath(this.#claimPath);
      if (!sameIdentity(beforeRemove, claim.identity)) {
        return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
      }
      rmdirSync(this.#claimPath);
      this.#claim = null;
      this.#claimReady = false;
      this.#fsyncDirectorySynchronously(this.#directory);
    } catch (error) {
      if (error instanceof RelayV2HostCredentialAtomicFileCellError) throw error;
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED");
    }
  }

  #fenceUncertain(): void {
    if (this.#lifecycle === "open") this.#lifecycle = "fenced";
  }

  #enterRecoveryRequired(): void {
    if (this.#lifecycle === "closed" || this.#lifecycle === "recovery-required") return;
    this.#lifecycle = "recovery-required";
    if (this.#closePromise !== null) this.#rejectRecoveryClose();
  }

  #rejectRecoveryClose(): void {
    const reject = this.#rejectClose;
    this.#resolveClose = null;
    this.#rejectClose = null;
    reject?.(new RelayV2HostCredentialAtomicFileCellError(
      "RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_RECOVERY_REQUIRED",
    ));
  }

  #settleCloseIfReady(): void {
    if (this.#lifecycle !== "closing" || this.#admitted !== 0) return;
    try {
      this.#cleanupOwnedState();
      this.#lifecycle = "closed";
      const resolve = this.#resolveClose;
      this.#resolveClose = null;
      this.#rejectClose = null;
      resolve?.();
    } catch (error) {
      if (this.#lifecycle === "recovery-required") {
        this.#rejectRecoveryClose();
        return;
      }
      this.#lifecycle = "closed";
      const reject = this.#rejectClose;
      this.#resolveClose = null;
      this.#rejectClose = null;
      reject?.(error);
    }
  }
}

function validateOpenOptions(options: unknown): {
  directory: string;
  directoryIdentity: FileIdentity;
  renameFile: (source: string, destination: string) => unknown;
  fsyncDirectory: (directory: string) => unknown;
} {
  if (!isRecord(options)
    || nodeUtilTypes.isProxy(options)
    || !exactKeys(options, ["directory"], ["syscalls"])) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
  }
  const directory = ownDataProperty(options, "directory");
  const syscalls = ownDataProperty(options, "syscalls");
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
  }
  let canonical: string;
  let information: BigIntStats;
  try {
    canonical = realpathSync.native(directory);
    information = statPath(directory);
  } catch {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
  }
  assertDirectoryStat(information);
  if (canonical !== directory) {
    return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_DIRECTORY_INVALID");
  }

  let renameFile: (source: string, destination: string) => unknown = renameSync;
  let fsyncDirectory: (path: string) => unknown = defaultFsyncDirectory;
  if (syscalls !== undefined) {
    if (!isRecord(syscalls)
      || nodeUtilTypes.isProxy(syscalls)
      || !exactKeys(syscalls, [], ["renameFile", "fsyncDirectory"])) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
    }
    const injectedRename = ownDataProperty(syscalls, "renameFile");
    const injectedFsync = ownDataProperty(syscalls, "fsyncDirectory");
    if ((injectedRename !== undefined && typeof injectedRename !== "function")
      || (injectedFsync !== undefined && typeof injectedFsync !== "function")) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_INVALID_OPTIONS");
    }
    if ((injectedRename !== undefined
        && (nodeUtilTypes.isProxy(injectedRename) || isNativeAsyncFunction(injectedRename)))
      || (injectedFsync !== undefined
        && (nodeUtilTypes.isProxy(injectedFsync) || isNativeAsyncFunction(injectedFsync)))) {
      return fail("RELAY_V2_HOST_CREDENTIAL_ATOMIC_FILE_CELL_ASYNC_OPERATION_UNSUPPORTED");
    }
    renameFile = injectedRename ?? renameFile;
    fsyncDirectory = injectedFsync ?? fsyncDirectory;
  }
  return {
    directory,
    directoryIdentity: identityOf(information),
    renameFile,
    fsyncDirectory,
  };
}

/**
 * Default-off secure atomic byte-cell foundation for one Relay v2 Host
 * credential vault envelope. It neither discovers a directory nor wires any
 * credential, process, network, readiness, capability, or fallback owner.
 */
export function openRelayV2HostCredentialAtomicFileCell(
  options: RelayV2HostCredentialAtomicFileCellOptions,
): RelayV2HostCredentialAtomicFileCell {
  const validated = validateOpenOptions(options);
  const owner = new AtomicFileCellOwner(
    validated.directory,
    validated.directoryIdentity,
    validated.renameFile,
    validated.fsyncDirectory,
  );
  return frozenMethodPort<RelayV2HostCredentialAtomicFileCell>({
    runExclusive: owner.runExclusive.bind(owner) as (...args: never[]) => unknown,
    closeAndDrain: owner.closeAndDrain.bind(owner) as (...args: never[]) => unknown,
  });
}
