import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import {
  isRelayV2HostCredentialReference,
  isRelayV2HostCredentialSecretReference,
} from "./hostCredentialAuthority.js";
import { isRelayV2AuthIdentifier } from "./token.js";

export const RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT =
  "tmux-worktree-relay-v2-host-production-profile" as const;
export const RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION = 1 as const;
export const RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES = 16 * 1024;
export const RELAY_V2_HOST_PRODUCTION_PROFILE_RELATIVE_PATH =
  ".tmux-worktree/relay-v2-host/profile-v1.json" as const;

const PROFILE_DIRECTORY_COMPONENTS = [".tmux-worktree", "relay-v2-host"] as const;
const PROFILE_FILENAME = "profile-v1.json";
const LOCK_FILENAME = "profile-v1.json.lock";
const TEMPORARY_PREFIX = ".profile-v1.json.tmp-";
const MAX_URL_BYTES = 2_048;
const MAX_LOCK_BYTES = 128;
const TEMPORARY_ATTEMPTS = 8;
const PROFILE_KEYS = [
  "contract",
  "schemaVersion",
  "hostId",
  "relayUrl",
  "credentialIssuerUrl",
  "credentialReference",
  "bootstrapSecretReference",
  "refreshSecretReference",
] as const;

type JsonObject = Record<string, unknown>;

export interface RelayV2HostProductionProfile {
  readonly contract: typeof RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT;
  readonly schemaVersion: typeof RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION;
  readonly hostId: string;
  readonly relayUrl: string;
  readonly credentialIssuerUrl: string;
  readonly credentialReference: string;
  readonly bootstrapSecretReference: string;
  readonly refreshSecretReference: string;
}

export interface RelayV2HostProductionProfileStoreOptions {
  readonly profile: unknown;
  /** Tests and privileged production composition may provide an exact trusted account home. */
  readonly trustedHome?: string;
}

export interface RelayV2HostProductionProfileReadOptions {
  /** Tests and privileged production composition may provide an exact trusted account home. */
  readonly trustedHome?: string;
}

export type RelayV2HostProductionProfileStoreErrorCode =
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_PLATFORM_UNSUPPORTED"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCKED"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_CONFLICT"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN"
  | "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED";

export class RelayV2HostProductionProfileStoreError extends Error {
  constructor(readonly code: RelayV2HostProductionProfileStoreErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2HostProductionProfileStoreError";
  }
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface DirectoryOwner {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface OwnedOpenFile {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
  readonly size: bigint;
}

interface StoragePaths {
  readonly directory: DirectoryOwner;
  readonly profile: string;
  readonly lock: string;
}

type ProfileInspection =
  | { readonly status: "missing" }
  | {
    readonly status: "present";
    readonly profile: Readonly<RelayV2HostProductionProfile>;
  };

function messageForCode(code: RelayV2HostProductionProfileStoreErrorCode): string {
  switch (code) {
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS":
      return "Relay v2 Host production profile options are invalid";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_PLATFORM_UNSUPPORTED":
      return "Relay v2 Host production profile storage is unsupported on this platform";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND":
      return "Relay v2 Host production profile does not exist";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE":
      return "Relay v2 Host production profile directory is unsafe";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCKED":
      return "Relay v2 Host production profile storage is already owned";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE":
      return "Relay v2 Host production profile lock is unsafe";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE":
      return "Relay v2 Host production profile file is unsafe";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID":
      return "Relay v2 Host production profile is invalid";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_CONFLICT":
      return "Relay v2 Host production profile conflicts with the existing profile";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE":
      return "Relay v2 Host production profile storage I/O failed";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN":
      return "Relay v2 Host production profile commit is uncertain";
    case "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED":
      return "Relay v2 Host production profile storage requires explicit recovery";
  }
}

function fail(code: RelayV2HostProductionProfileStoreErrorCode): never {
  throw new RelayV2HostProductionProfileStoreError(code);
}

function isTypedError(error: unknown): error is RelayV2HostProductionProfileStoreError {
  return error instanceof RelayV2HostProductionProfileStoreError;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureExactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<JsonObject> | null {
  if (!isRecord(value) || nodeUtilTypes.isProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return null;
    if (required.some((key) => !Object.hasOwn(descriptors, key))) return null;
    const captured = Object.create(null) as JsonObject;
    for (const key of [...required, ...optional]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function exactRootUrl(value: unknown, protocol: "wss:" | "https:"): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === protocol
    && parsed.hostname.length > 0
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === ""
    && parsed.toString() === value;
}

function captureProfile(
  value: unknown,
  errorCode: "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS"
    | "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID",
): Readonly<RelayV2HostProductionProfile> {
  const fields = captureExactDataRecord(value, PROFILE_KEYS);
  if (fields === null
    || fields.contract !== RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT
    || fields.schemaVersion !== RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION
    || !isRelayV2AuthIdentifier(fields.hostId)
    || !exactRootUrl(fields.relayUrl, "wss:")
    || !exactRootUrl(fields.credentialIssuerUrl, "https:")
    || !isRelayV2HostCredentialReference(fields.credentialReference)
    || !isRelayV2HostCredentialSecretReference(fields.bootstrapSecretReference)
    || !isRelayV2HostCredentialSecretReference(fields.refreshSecretReference)
    || fields.bootstrapSecretReference === fields.refreshSecretReference) {
    return fail(errorCode);
  }
  return Object.freeze(Object.assign(Object.create(null), {
    contract: RELAY_V2_HOST_PRODUCTION_PROFILE_CONTRACT,
    schemaVersion: RELAY_V2_HOST_PRODUCTION_PROFILE_SCHEMA_VERSION,
    hostId: fields.hostId,
    relayUrl: fields.relayUrl,
    credentialIssuerUrl: fields.credentialIssuerUrl,
    credentialReference: fields.credentialReference,
    bootstrapSecretReference: fields.bootstrapSecretReference,
    refreshSecretReference: fields.refreshSecretReference,
  })) as Readonly<RelayV2HostProductionProfile>;
}

function sameProfile(
  left: Readonly<RelayV2HostProductionProfile>,
  right: Readonly<RelayV2HostProductionProfile>,
): boolean {
  return PROFILE_KEYS.every((key) => left[key] === right[key]);
}

function serializeProfile(profile: Readonly<RelayV2HostProductionProfile>): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
  if (bytes.byteLength > RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS");
  }
  return bytes;
}

function requireSupportedPlatform(): bigint {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof fsConstants.O_DIRECTORY !== "number") {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_PLATFORM_UNSUPPORTED");
  }
  return BigInt(process.geteuid());
}

function identityOf(information: BigIntStats): FileIdentity {
  return Object.freeze({ dev: information.dev, ino: information.ino });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function modeOf(information: BigIntStats): number {
  return Number(information.mode & 0o7777n);
}

function statPath(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function statDescriptor(descriptor: number): BigIntStats {
  return fstatSync(descriptor, { bigint: true });
}

function assertOwnedDirectory(
  path: string,
  information: BigIntStats,
  uid: bigint,
  privateMode: boolean,
): void {
  if (!information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== uid
    || (privateMode && modeOf(information) !== 0o700)) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
  if (canonical !== path) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
}

function assertOwnedRegularFile(
  information: BigIntStats,
  uid: bigint,
  maximumBytes: number,
  code: "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE"
    | "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE"
    | "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
  expectedLinkCount = 1n,
): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== uid
    || modeOf(information) !== 0o600
    || information.nlink !== expectedLinkCount
    || information.size < 0n
    || information.size > BigInt(maximumBytes)) return fail(code);
}

function assertDirectoryOwner(owner: DirectoryOwner, uid: bigint): void {
  let information: BigIntStats;
  try {
    information = statPath(owner.path);
    assertOwnedDirectory(owner.path, information, uid, true);
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
  if (!sameIdentity(owner.identity, identityOf(information))) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
}

function fsyncDirectory(owner: DirectoryOwner, uid: bigint): void {
  assertDirectoryOwner(owner, uid);
  let descriptor = -1;
  try {
    descriptor = openSync(
      owner.path,
      fsConstants.O_RDONLY
        | fsConstants.O_DIRECTORY
        | fsConstants.O_NOFOLLOW,
    );
    const opened = statDescriptor(descriptor);
    assertOwnedDirectory(owner.path, opened, uid, true);
    if (!sameIdentity(owner.identity, identityOf(opened))) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
  } finally {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function ensurePrivateChildDirectory(
  path: string,
  parent: { readonly path: string; readonly identity: FileIdentity; readonly privateMode: boolean },
  uid: bigint,
): DirectoryOwner {
  let created = false;
  try {
    const parentInformation = statPath(parent.path);
    assertOwnedDirectory(parent.path, parentInformation, uid, parent.privateMode);
    if (!sameIdentity(parent.identity, identityOf(parentInformation))) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
    }
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const information = statPath(path);
    assertOwnedDirectory(path, information, uid, true);
    const owner = Object.freeze({ path, identity: identityOf(information) });
    if (created) {
      let descriptor = -1;
      try {
        descriptor = openSync(
          parent.path,
          fsConstants.O_RDONLY
            | fsConstants.O_DIRECTORY
            | fsConstants.O_NOFOLLOW,
        );
        const openedParent = statDescriptor(descriptor);
        if (!sameIdentity(parent.identity, identityOf(openedParent))) {
          return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
        }
        fsyncSync(descriptor);
      } finally {
        if (descriptor >= 0) closeSync(descriptor);
      }
      assertDirectoryOwner(owner, uid);
    }
    return owner;
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
}

function existingPrivateChildDirectory(
  path: string,
  parent: { readonly path: string; readonly identity: FileIdentity; readonly privateMode: boolean },
  uid: bigint,
): DirectoryOwner {
  try {
    const parentInformation = statPath(parent.path);
    assertOwnedDirectory(parent.path, parentInformation, uid, parent.privateMode);
    if (!sameIdentity(parent.identity, identityOf(parentInformation))) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
    }
    const information = statPath(path);
    assertOwnedDirectory(path, information, uid, true);
    return Object.freeze({ path, identity: identityOf(information) });
  } catch (error) {
    if (isTypedError(error)) throw error;
    if (isMissing(error)) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND");
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
}

function trustedHomeOwner(trustedHome: string, uid: bigint): DirectoryOwner {
  if (!isAbsolute(trustedHome) || trustedHome.includes("\0")) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS");
  }
  try {
    const information = statPath(trustedHome);
    assertOwnedDirectory(trustedHome, information, uid, false);
    return Object.freeze({ path: trustedHome, identity: identityOf(information) });
  } catch (error) {
    if (isTypedError(error)) throw error;
    if (isMissing(error)) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND");
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_DIRECTORY_UNSAFE");
  }
}

function storagePaths(trustedHome: string, uid: bigint): StoragePaths {
  const home = trustedHomeOwner(trustedHome, uid);
  let parent: {
    readonly path: string;
    readonly identity: FileIdentity;
    readonly privateMode: boolean;
  } = {
    path: home.path,
    identity: home.identity,
    privateMode: false,
  };
  for (const component of PROFILE_DIRECTORY_COMPONENTS) {
    const directory = ensurePrivateChildDirectory(join(parent.path, component), parent, uid);
    parent = { ...directory, privateMode: true };
  }
  const directory = Object.freeze({ path: parent.path, identity: parent.identity });
  return Object.freeze({
    directory,
    profile: join(directory.path, PROFILE_FILENAME),
    lock: join(directory.path, LOCK_FILENAME),
  });
}

function existingStoragePaths(trustedHome: string, uid: bigint): StoragePaths {
  const home = trustedHomeOwner(trustedHome, uid);
  let parent: {
    readonly path: string;
    readonly identity: FileIdentity;
    readonly privateMode: boolean;
  } = { path: home.path, identity: home.identity, privateMode: false };
  for (const component of PROFILE_DIRECTORY_COMPONENTS) {
    const directory = existingPrivateChildDirectory(join(parent.path, component), parent, uid);
    parent = { ...directory, privateMode: true };
  }
  const directory = Object.freeze({ path: parent.path, identity: parent.identity });
  return Object.freeze({
    directory,
    profile: join(directory.path, PROFILE_FILENAME),
    lock: join(directory.path, LOCK_FILENAME),
  });
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written <= 0) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
    offset += written;
  }
}

function readExact(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(descriptor, bytes, offset, size - offset, offset);
    if (read <= 0) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID");
    offset += read;
  }
  return bytes;
}

function inspectProfile(path: string, uid: bigint): ProfileInspection {
  let before: BigIntStats;
  try {
    before = statPath(path);
  } catch (error) {
    if (isMissing(error)) return Object.freeze({ status: "missing" });
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE");
  }
  assertOwnedRegularFile(
    before,
    uid,
    RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
    "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE",
  );
  let descriptor = -1;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = statDescriptor(descriptor);
    assertOwnedRegularFile(
      opened,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE",
    );
    if (!sameIdentity(identityOf(before), identityOf(opened)) || before.size !== opened.size) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE");
    }
    const bytes = readExact(descriptor, Number(opened.size));
    const afterDescriptor = statDescriptor(descriptor);
    const afterPath = statPath(path);
    assertOwnedRegularFile(
      afterDescriptor,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE",
    );
    assertOwnedRegularFile(
      afterPath,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE",
    );
    if (!sameIdentity(identityOf(opened), identityOf(afterDescriptor))
      || !sameIdentity(identityOf(opened), identityOf(afterPath))
      || opened.size !== afterDescriptor.size
      || opened.size !== afterPath.size) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE");
    }
    let decoded: unknown;
    try {
      decoded = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(bytes), {
        maxDepth: 2,
        maxKeys: PROFILE_KEYS.length,
        maxNodes: PROFILE_KEYS.length + 1,
      });
    } catch {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID");
    }
    return Object.freeze({
      status: "present",
      profile: captureProfile(decoded, "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID"),
    });
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_FILE_UNSAFE");
  } finally {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function assertOwnedOpenFile(
  file: OwnedOpenFile,
  uid: bigint,
  maximumBytes: number,
  code: "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE"
    | "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
): void {
  const descriptorInformation = statDescriptor(file.descriptor);
  const pathInformation = statPath(file.path);
  assertOwnedRegularFile(descriptorInformation, uid, maximumBytes, code);
  assertOwnedRegularFile(pathInformation, uid, maximumBytes, code);
  if (!sameIdentity(file.identity, identityOf(descriptorInformation))
    || !sameIdentity(file.identity, identityOf(pathInformation))
    || descriptorInformation.size !== file.size
    || pathInformation.size !== file.size) return fail(code);
}

function assertNoStoreLock(paths: StoragePaths, uid: bigint): void {
  assertDirectoryOwner(paths.directory, uid);
  let information: BigIntStats;
  try {
    information = statPath(paths.lock);
  } catch (error) {
    if (isMissing(error)) return;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
  }
  assertOwnedRegularFile(
    information,
    uid,
    MAX_LOCK_BYTES,
    "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE",
  );
  return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCKED");
}

function acquireLock(paths: StoragePaths, uid: bigint): OwnedOpenFile {
  assertDirectoryOwner(paths.directory, uid);
  let descriptor = -1;
  let created = false;
  let identity: FileIdentity | null = null;
  try {
    try {
      descriptor = openSync(
        paths.lock,
        fsConstants.O_RDWR
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let existing: BigIntStats;
      try {
        existing = statPath(paths.lock);
        assertOwnedRegularFile(
          existing,
          uid,
          MAX_LOCK_BYTES,
          "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE",
        );
      } catch (inspectionError) {
        if (isTypedError(inspectionError)) throw inspectionError;
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
      }
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCKED");
    }
    fchmodSync(descriptor, 0o600);
    const empty = statDescriptor(descriptor);
    assertOwnedRegularFile(
      empty,
      uid,
      MAX_LOCK_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE",
    );
    if (empty.size !== 0n) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
    identity = identityOf(empty);
    const token = Buffer.from(`${randomBytes(32).toString("base64url")}\n`, "ascii");
    writeAll(descriptor, token);
    fsyncSync(descriptor);
    const complete = statDescriptor(descriptor);
    assertOwnedRegularFile(
      complete,
      uid,
      MAX_LOCK_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE",
    );
    if (!sameIdentity(identity, identityOf(complete))
      || complete.size !== BigInt(token.byteLength)) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
    }
    const lock = Object.freeze({
      path: paths.lock,
      descriptor,
      identity,
      size: complete.size,
    });
    assertOwnedOpenFile(lock, uid, MAX_LOCK_BYTES, "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
    fsyncDirectory(paths.directory, uid);
    return lock;
  } catch (error) {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
      descriptor = -1;
    }
    if (created) {
      if (identity === null) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      try {
        const current = statPath(paths.lock);
        assertOwnedRegularFile(
          current,
          uid,
          MAX_LOCK_BYTES,
          "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
        );
        if (!sameIdentity(identity, identityOf(current))) {
          return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
        }
        unlinkSync(paths.lock);
        fsyncDirectory(paths.directory, uid);
      } catch {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      }
    }
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
  }
}

function releaseLock(
  paths: StoragePaths,
  lock: OwnedOpenFile,
  uid: bigint,
): void {
  try {
    assertDirectoryOwner(paths.directory, uid);
    assertOwnedOpenFile(
      lock,
      uid,
      MAX_LOCK_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
    );
    unlinkSync(lock.path);
    try {
      statPath(lock.path);
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    fsyncDirectory(paths.directory, uid);
    closeSync(lock.descriptor);
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
  }
}

function closePreservedLock(lock: OwnedOpenFile): void {
  try { closeSync(lock.descriptor); } catch {}
}

function createTemporary(
  paths: StoragePaths,
  bytes: Buffer,
  lock: OwnedOpenFile,
  uid: bigint,
): OwnedOpenFile {
  for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS; attempt += 1) {
    assertDirectoryOwner(paths.directory, uid);
    assertOwnedOpenFile(lock, uid, MAX_LOCK_BYTES, "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
    const path = join(paths.directory.path, `${TEMPORARY_PREFIX}${randomBytes(32).toString("hex")}`);
    let descriptor = -1;
    let identity: FileIdentity | null = null;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
    }
    try {
      fchmodSync(descriptor, 0o600);
      const empty = statDescriptor(descriptor);
      assertOwnedRegularFile(
        empty,
        uid,
        RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
        "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      );
      if (empty.size !== 0n) return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      identity = identityOf(empty);
      writeAll(descriptor, bytes);
      fsyncSync(descriptor);
      const complete = statDescriptor(descriptor);
      assertOwnedRegularFile(
        complete,
        uid,
        RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
        "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      );
      if (!sameIdentity(identity, identityOf(complete))
        || complete.size !== BigInt(bytes.byteLength)) {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      }
      const temporary = Object.freeze({ path, descriptor, identity, size: complete.size });
      assertOwnedOpenFile(
        temporary,
        uid,
        RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
        "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      );
      return temporary;
    } catch (error) {
      if (identity === null && descriptor >= 0) {
        try { identity = identityOf(statDescriptor(descriptor)); } catch {}
      }
      try { closeSync(descriptor); } catch {}
      if (identity === null) {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      }
      try {
        const current = statPath(path);
        if (!current.isFile()
          || current.isSymbolicLink()
          || current.uid !== uid
          || current.nlink !== 1n
          || !sameIdentity(identity, identityOf(current))) {
          return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
        }
        unlinkSync(path);
        fsyncDirectory(paths.directory, uid);
      } catch {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      }
      if (isTypedError(error)) throw error;
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
    }
  }
  return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
}

function cleanupTemporary(
  paths: StoragePaths,
  temporary: OwnedOpenFile,
  uid: bigint,
): void {
  try {
    assertOwnedOpenFile(
      temporary,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
    );
    unlinkSync(temporary.path);
    fsyncDirectory(paths.directory, uid);
    closeSync(temporary.descriptor);
  } catch (error) {
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
  }
}

function publishProfile(
  paths: StoragePaths,
  profile: Readonly<RelayV2HostProductionProfile>,
  bytes: Buffer,
  lock: OwnedOpenFile,
  uid: bigint,
): void {
  const temporary = createTemporary(paths, bytes, lock, uid);
  let committed = false;
  let temporaryDisposed = false;
  try {
    assertDirectoryOwner(paths.directory, uid);
    assertOwnedOpenFile(lock, uid, MAX_LOCK_BYTES, "RELAY_V2_HOST_PRODUCTION_PROFILE_LOCK_UNSAFE");
    assertOwnedOpenFile(
      temporary,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
    );
    try {
      linkSync(temporary.path, paths.profile);
      committed = true;
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException)?.code === "EEXIST") {
        let current: ProfileInspection;
        try {
          current = inspectProfile(paths.profile, uid);
        } catch (inspectionError) {
          temporaryDisposed = true;
          cleanupTemporary(paths, temporary, uid);
          throw inspectionError;
        }
        temporaryDisposed = true;
        cleanupTemporary(paths, temporary, uid);
        if (current.status === "missing") {
          return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
        }
        if (sameProfile(current.profile, profile)) return;
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_CONFLICT");
      }
      let definiteNoCommit = false;
      try {
        assertOwnedOpenFile(
          temporary,
          uid,
          RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
          "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
        );
        definiteNoCommit = inspectProfile(paths.profile, uid).status === "missing";
      } catch {}
      if (definiteNoCommit) {
        temporaryDisposed = true;
        cleanupTemporary(paths, temporary, uid);
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
      }
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    }

    const source = statPath(temporary.path);
    const published = statPath(paths.profile);
    const descriptorInformation = statDescriptor(temporary.descriptor);
    assertOwnedRegularFile(
      source,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      2n,
    );
    assertOwnedRegularFile(
      published,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      2n,
    );
    assertOwnedRegularFile(
      descriptorInformation,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
      2n,
    );
    if (!sameIdentity(temporary.identity, identityOf(source))
      || !sameIdentity(temporary.identity, identityOf(published))
      || !sameIdentity(temporary.identity, identityOf(descriptorInformation))
      || source.size !== temporary.size
      || published.size !== temporary.size
      || descriptorInformation.size !== temporary.size) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    }

    unlinkSync(temporary.path);
    try {
      statPath(temporary.path);
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const finalProfile = statPath(paths.profile);
    const finalDescriptor = statDescriptor(temporary.descriptor);
    assertOwnedRegularFile(
      finalProfile,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
    );
    assertOwnedRegularFile(
      finalDescriptor,
      uid,
      RELAY_V2_HOST_PRODUCTION_PROFILE_MAX_BYTES,
      "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED",
    );
    if (!sameIdentity(temporary.identity, identityOf(finalProfile))
      || !sameIdentity(temporary.identity, identityOf(finalDescriptor))
      || finalProfile.size !== temporary.size
      || finalDescriptor.size !== temporary.size) {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    }
    fsyncDirectory(paths.directory, uid);
    try {
      closeSync(temporary.descriptor);
      temporaryDisposed = true;
    } catch {
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    }
  } catch (error) {
    if (committed) {
      try { closeSync(temporary.descriptor); } catch {}
      if (isTypedError(error)
        && error.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN") throw error;
      return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN");
    }
    if (isTypedError(error)
      && error.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED") throw error;
    if (!temporaryDisposed) {
      temporaryDisposed = true;
      try {
        cleanupTemporary(paths, temporary, uid);
      } catch {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
      }
    }
    if (isTypedError(error)) throw error;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
  }
}

export function relayV2HostProductionProfilePath(trustedHome = homedir()): string {
  return join(trustedHome, ...PROFILE_DIRECTORY_COMPONENTS, PROFILE_FILENAME);
}

/**
 * Reads the one existing immutable profile without accepting a replacement
 * draft and without creating, locking, repairing, or migrating filesystem
 * state. An active or unsafe writer lock fails closed.
 */
export function readRelayV2HostProductionProfile(
  options: RelayV2HostProductionProfileReadOptions = {},
): Readonly<RelayV2HostProductionProfile> {
  const capturedOptions = captureExactDataRecord(options, [], ["trustedHome"]);
  if (capturedOptions === null
    || (capturedOptions.trustedHome !== undefined
      && typeof capturedOptions.trustedHome !== "string")) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS");
  }
  const uid = requireSupportedPlatform();
  const trustedHome = capturedOptions.trustedHome === undefined
    ? homedir()
    : capturedOptions.trustedHome;
  const paths = existingStoragePaths(trustedHome as string, uid);
  assertNoStoreLock(paths, uid);
  const current = inspectProfile(paths.profile, uid);
  assertDirectoryOwner(paths.directory, uid);
  assertNoStoreLock(paths, uid);
  if (current.status === "missing") {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_NOT_FOUND");
  }
  return current.profile;
}

/**
 * Creates one immutable Relay v2 Host production profile or returns the exact
 * existing profile. This is the only writer; it stores references, never their
 * credential or secret material, and performs no migration or fallback.
 */
export function loadOrCreateRelayV2HostProductionProfile(
  options: RelayV2HostProductionProfileStoreOptions,
): Readonly<RelayV2HostProductionProfile> {
  const capturedOptions = captureExactDataRecord(options, ["profile"], ["trustedHome"]);
  if (capturedOptions === null
    || (capturedOptions.trustedHome !== undefined
      && typeof capturedOptions.trustedHome !== "string")) {
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS");
  }
  const profile = captureProfile(
    capturedOptions.profile,
    "RELAY_V2_HOST_PRODUCTION_PROFILE_INVALID_OPTIONS",
  );
  const bytes = serializeProfile(profile);
  const uid = requireSupportedPlatform();
  const trustedHome = capturedOptions.trustedHome === undefined
    ? homedir()
    : capturedOptions.trustedHome;
  const paths = storagePaths(trustedHome as string, uid);
  const lock = acquireLock(paths, uid);
  let preserveLock = false;
  let operationError: unknown = null;
  try {
    const current = inspectProfile(paths.profile, uid);
    if (current.status === "present") {
      if (!sameProfile(current.profile, profile)) {
        return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_CONFLICT");
      }
    } else {
      publishProfile(paths, profile, bytes, lock, uid);
    }
  } catch (error) {
    operationError = error;
    preserveLock = isTypedError(error)
      && (error.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_COMMIT_UNCERTAIN"
        || error.code === "RELAY_V2_HOST_PRODUCTION_PROFILE_RECOVERY_REQUIRED");
  }

  if (preserveLock) {
    closePreservedLock(lock);
  } else {
    try {
      releaseLock(paths, lock, uid);
    } catch (releaseError) {
      operationError = releaseError;
    }
  }
  if (operationError !== null) {
    if (isTypedError(operationError)) throw operationError;
    return fail("RELAY_V2_HOST_PRODUCTION_PROFILE_IO_FAILURE");
  }
  return profile;
}
