import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES,
  RelayV2BrokerCredentialStateStoreError,
  type RelayV2BrokerCredentialStateRevision,
  type RelayV2BrokerCredentialStateStore,
  type RelayV2BrokerCredentialStateTransaction,
} from "./brokerCredentialStateStore.js";
import type {
  RelayV2ContinuityAnchorCasRequest,
  RelayV2ContinuityAnchorReadRequest,
  RelayV2ContinuityCheckpoint,
  RelayV2ContinuityAnchorSnapshot,
  RelayV2MonotonicCasAuthority,
} from "./continuityAnchor.js";
import {
  createRelayV2IssuerKeyring,
  parseRelayV2IssuerKeyring,
  type RelayV2IssuerKeyring,
} from "./issuer.js";
import {
  captureRelayV2BrokerDevelopmentAdvertisedEndpoints,
  readRelayV2BrokerDevelopmentTlsFile,
} from "./brokerLocalDevelopmentActivation.js";
import {
  RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY,
  startRelayV2BrokerShippingRoot,
  type RelayV2BrokerShippingNonProductionCredentialAuthorityOpener,
  type RelayV2BrokerShippingRootHandle,
} from "./brokerShippingRoot.js";
import {
  RelayV2BrokerCredentialAuthority,
  type RelayV2BrokerCredentialAuthorityGenesis,
} from "./brokerCredentialAuthority.js";
import type { RelayV2LiveAuthorizationFencePort } from "./brokerCore.js";
import type {
  RelayV2BrokerServerAgentCapabilityReadinessReceipt,
} from "../broker/server.js";

const ACTIVATION_FAILED =
  "Relay v2 single-node self-hosted Broker activation failed";
const POLICY =
  "non-production-linux-x64-single-process-no-restore-no-copy-v1";
const DATABASE_FILE_NAME = "broker-state.sqlite3";
const DATABASE_JOURNAL_FILE_NAME = `${DATABASE_FILE_NAME}-journal`;
const DATABASE_MAX_BYTES = 160 * 1024 * 1024;
const DATABASE_SCHEMA_VERSION = 1;
const KEYRING_REFERENCE = "single-node-persistent-keyring";
const TLS_KEY_REFERENCE = "single-node-tls-key";
const TLS_CERTIFICATE_REFERENCE = "single-node-tls-certificate";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const EXT_FILESYSTEM_MAGIC = 0xef53n;

export interface RelayV2BrokerSingleNodeSelfHostedOptions {
  readonly host: string;
  readonly port: number;
  readonly advertisedOrigin: string;
  readonly tlsKeyPath: string;
  readonly tlsCertificatePath: string;
  readonly stateDirectory: string;
  /** Explicit optional routing receipt; omission remains default-off. */
  readonly agentTranscriptLifecycleReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  /** Explicit optional agent.chat.v2 routing receipt; omission remains default-off. */
  readonly agentChatReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  /** Explicit optional lark.bindings.v2 routing receipt; omission remains default-off. */
  readonly larkBindingsReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
}

type CapturedOptions = Readonly<{
  host: string;
  port: number;
  issuerUrl: string;
  relayUrl: string;
  tlsKeyPath: string;
  tlsCertificatePath: string;
  stateDirectory: string;
  agentTranscriptLifecycleReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  agentChatReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
  larkBindingsReadiness?:
    RelayV2BrokerServerAgentCapabilityReadinessReceipt;
}>;

interface SqliteStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): Readonly<{ changes: number | bigint }>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

type RevisionOwner = Readonly<{
  transactionIdentity: object;
  generation: string;
}>;

type PersistedMetadata = Readonly<{
  deploymentId: string;
  machineIdSha256: string;
  directoryDevice: string;
  directoryInode: string;
  issuerUrl: string;
  relayUrl: string;
  issuerKeyring: RelayV2IssuerKeyring;
}>;

type CredentialRow = Readonly<{
  generation: string;
  bytes: Uint8Array | null;
}>;

type ContinuityRow = Readonly<{
  generation: string;
  snapshot: RelayV2ContinuityAnchorSnapshot;
}>;

function failure(): Error {
  return new Error(ACTIVATION_FAILED);
}

function isErrno(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && Object.getOwnPropertyDescriptor(error, "code")?.value === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function captureOwnDataOptions(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (nodeUtilTypes.isProxy(value)) return null;
  } catch {
    return null;
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const required = [
    "host",
    "port",
    "advertisedOrigin",
    "tlsKeyPath",
    "tlsCertificatePath",
    "stateDirectory",
  ];
  const optional = [
    "agentTranscriptLifecycleReadiness",
    "agentChatReadiness",
    "larkBindingsReadiness",
  ];
  const allowed = [...required, ...optional];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
  ) return null;
  const captured: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) return null;
    captured[key] = descriptor.value;
  }
  return captured;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalUint64(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= UINT64_MAX;
  } catch {
    return false;
  }
}

function incrementUint64(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > UINT64_MAX) {
    throw new RelayV2BrokerCredentialStateStoreError("GENERATION_EXHAUSTED");
  }
  return next.toString();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function row(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw failure();
  return value;
}

function onlyValue(value: unknown): unknown {
  const captured = row(value);
  const values = Object.values(captured);
  if (values.length !== 1) throw failure();
  return values[0];
}

function nodeVersionSupported(): boolean {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(process.versions.node);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 16);
}

function captureOptions(value: unknown): CapturedOptions {
  const captured = captureOwnDataOptions(value);
  if (captured === null) throw failure();
  if (
    typeof captured.host !== "string"
    || captured.host.length === 0
    || captured.host !== captured.host.trim()
    || Buffer.byteLength(captured.host, "utf8") > 255
    || captured.host.includes("\0")
    || !Number.isInteger(captured.port)
    || (captured.port as number) < 1
    || (captured.port as number) > 65_535
    || typeof captured.advertisedOrigin !== "string"
    || captured.advertisedOrigin.length === 0
    || typeof captured.tlsKeyPath !== "string"
    || captured.tlsKeyPath.length === 0
    || typeof captured.tlsCertificatePath !== "string"
    || captured.tlsCertificatePath.length === 0
    || typeof captured.stateDirectory !== "string"
    || captured.stateDirectory.length === 0
  ) throw failure();
  const endpoints = captureRelayV2BrokerDevelopmentAdvertisedEndpoints(
    captured.advertisedOrigin,
    captured.port as number,
  );
  return Object.freeze({
    host: captured.host,
    port: captured.port as number,
    issuerUrl: endpoints.issuerUrl,
    relayUrl: endpoints.relayUrl,
    tlsKeyPath: captured.tlsKeyPath,
    tlsCertificatePath: captured.tlsCertificatePath,
    stateDirectory: captured.stateDirectory,
    ...(captured.agentTranscriptLifecycleReadiness === undefined
      ? {}
      : {
          agentTranscriptLifecycleReadiness:
            captured.agentTranscriptLifecycleReadiness as
              RelayV2BrokerServerAgentCapabilityReadinessReceipt,
        }),
    ...(captured.agentChatReadiness === undefined
      ? {}
      : {
          agentChatReadiness:
            captured.agentChatReadiness as
              RelayV2BrokerServerAgentCapabilityReadinessReceipt,
        }),
    ...(captured.larkBindingsReadiness === undefined
      ? {}
      : {
          larkBindingsReadiness:
            captured.larkBindingsReadiness as
              RelayV2BrokerServerAgentCapabilityReadinessReceipt,
        }),
  });
}

function assertStateDirectory(
  information: BigIntStats,
  euid: bigint,
): void {
  if (
    !information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== euid
    || Number(information.mode & 0o7777n) !== 0o700
  ) throw failure();
}

function assertPrivateFile(
  information: BigIntStats,
  euid: bigint,
  maxBytes: number,
  allowEmpty: boolean,
): void {
  if (
    !information.isFile()
    || information.isSymbolicLink()
    || information.uid !== euid
    || Number(information.mode & 0o7777n) !== 0o600
    || information.nlink !== 1n
    || information.size < (allowEmpty ? 0n : 1n)
    || information.size > BigInt(maxBytes)
  ) throw failure();
}

function readMachineIdentity(): string {
  let value: string;
  try {
    value = readFileSync("/etc/machine-id", "utf8").trim().toLowerCase();
  } catch {
    throw failure();
  }
  if (!/^[0-9a-f]{32}$/.test(value)) throw failure();
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function openStateDirectory(
  stateDirectory: string,
): Readonly<{
  descriptor: number;
  euid: bigint;
  device: string;
  inode: string;
}> {
  if (
    process.platform !== "linux"
    || process.arch !== "x64"
    || !nodeVersionSupported()
    || typeof process.geteuid !== "function"
    || typeof fsConstants.O_NOFOLLOW !== "number"
    || typeof fsConstants.O_DIRECTORY !== "number"
    || !isAbsolute(stateDirectory)
    || stateDirectory.includes("\0")
  ) throw failure();
  const euid = BigInt(process.geteuid());
  let descriptor = -1;
  try {
    if (realpathSync(stateDirectory) !== stateDirectory) throw failure();
    const before = lstatSync(stateDirectory, { bigint: true });
    assertStateDirectory(before, euid);
    descriptor = openSync(
      stateDirectory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    assertStateDirectory(opened, euid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw failure();
    if (statfsSync(stateDirectory, { bigint: true }).type
      !== EXT_FILESYSTEM_MAGIC) throw failure();
    return Object.freeze({
      descriptor,
      euid,
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
    });
  } catch {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
    throw failure();
  }
}

function verifyDedicatedDirectoryEntries(
  stateDirectory: string,
  euid: bigint,
): void {
  let entries: string[];
  try {
    entries = readdirSync(stateDirectory);
  } catch {
    throw failure();
  }
  for (const entry of entries) {
    if (entry !== DATABASE_FILE_NAME && entry !== DATABASE_JOURNAL_FILE_NAME) {
      throw failure();
    }
    const information = lstatSync(join(stateDirectory, entry), { bigint: true });
    assertPrivateFile(information, euid, DATABASE_MAX_BYTES, true);
  }
}

function prepareDatabaseFile(
  stateDirectory: string,
  directoryDescriptor: number,
  euid: bigint,
): string {
  const databasePath = join(stateDirectory, DATABASE_FILE_NAME);
  let information: BigIntStats | null = null;
  try {
    information = lstatSync(databasePath, { bigint: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw failure();
  }
  if (information !== null) {
    assertPrivateFile(information, euid, DATABASE_MAX_BYTES, true);
    return databasePath;
  }
  let descriptor = -1;
  try {
    descriptor = openSync(
      databasePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    const opened = fstatSync(descriptor, { bigint: true });
    assertPrivateFile(opened, euid, DATABASE_MAX_BYTES, true);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = -1;
    fsyncSync(directoryDescriptor);
    return databasePath;
  } catch {
    if (descriptor >= 0) {
      try { closeSync(descriptor); } catch {}
    }
    throw failure();
  }
}

function configureDatabase(database: SqliteDatabase): void {
  try {
    database.exec("PRAGMA busy_timeout=0");
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("PRAGMA synchronous=FULL");
    database.exec("PRAGMA locking_mode=EXCLUSIVE");
    database.exec("PRAGMA temp_store=MEMORY");
    database.exec("PRAGMA trusted_schema=OFF");
    database.exec("PRAGMA foreign_keys=ON");
    database.exec("PRAGMA secure_delete=ON");
    database.exec("BEGIN EXCLUSIVE; COMMIT");
    if (
      onlyValue(database.prepare("PRAGMA journal_mode").get()) !== "delete"
      || onlyValue(database.prepare("PRAGMA synchronous").get()) !== 2
      || onlyValue(database.prepare("PRAGMA locking_mode").get()) !== "exclusive"
      || onlyValue(database.prepare("PRAGMA quick_check").get()) !== "ok"
    ) throw failure();
  } catch {
    throw failure();
  }
}

function sqliteObjects(database: SqliteDatabase): readonly string[] {
  const objects = database.prepare(
    "SELECT type || ':' || name AS identity "
      + "FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all();
  return objects.map((candidate) => {
    const captured = row(candidate);
    if (typeof captured.identity !== "string") throw failure();
    return captured.identity;
  });
}

function initializeDatabase(
  database: SqliteDatabase,
  metadata: Omit<PersistedMetadata, "issuerKeyring">,
): PersistedMetadata {
  if (
    onlyValue(database.prepare("PRAGMA user_version").get()) !== 0
    || sqliteObjects(database).length !== 0
  ) throw failure();
  const issuerKeyring = createRelayV2IssuerKeyring({
    issuerId: `single-node-${metadata.deploymentId}`,
    kid: `single-node-key-${metadata.deploymentId}`,
    secretBase64url: randomBytes(32).toString("base64url"),
  });
  const anchorId = `single-node-anchor-${metadata.deploymentId}`;
  const continuity: RelayV2ContinuityAnchorSnapshot = {
    protocolVersion: 1,
    status: "uninitialized",
    anchorId,
    casToken: `single-node-cas-0-${metadata.deploymentId}`,
  };
  try {
    database.exec("BEGIN EXCLUSIVE");
    database.exec(`
      CREATE TABLE deployment_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        policy TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        machine_id_sha256 TEXT NOT NULL,
        directory_device TEXT NOT NULL,
        directory_inode TEXT NOT NULL,
        issuer_url TEXT NOT NULL,
        relay_url TEXT NOT NULL,
        issuer_keyring_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE owner_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        credential_generation TEXT NOT NULL,
        credential_state BLOB,
        continuity_generation TEXT NOT NULL,
        continuity_json TEXT NOT NULL
      ) STRICT;
    `);
    database.prepare(
      "INSERT INTO deployment_config VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      POLICY,
      metadata.deploymentId,
      metadata.machineIdSha256,
      metadata.directoryDevice,
      metadata.directoryInode,
      metadata.issuerUrl,
      metadata.relayUrl,
      JSON.stringify(issuerKeyring),
    );
    database.prepare(
      "INSERT INTO owner_state VALUES (1, '0', NULL, '0', ?)",
    ).run(JSON.stringify(continuity));
    database.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch {
    try { database.exec("ROLLBACK"); } catch {}
    throw failure();
  }
  return Object.freeze({ ...metadata, issuerKeyring });
}

function parseCheckpoint(
  value: unknown,
  anchorId: string,
): RelayV2ContinuityCheckpoint {
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocolVersion",
    "anchorId",
    "sequence",
    "commitId",
    "parentCommitId",
    "stateDigest",
  ])) throw failure();
  if (
    value.protocolVersion !== 1
    || value.anchorId !== anchorId
    || !canonicalUint64(value.sequence)
    || typeof value.commitId !== "string"
    || !IDENTIFIER.test(value.commitId)
    || (value.parentCommitId !== null
      && (typeof value.parentCommitId !== "string"
        || !IDENTIFIER.test(value.parentCommitId)))
    || typeof value.stateDigest !== "string"
    || !HEX_64.test(value.stateDigest)
  ) throw failure();
  const sequence = BigInt(value.sequence);
  if (
    (sequence === 0n && value.parentCommitId !== null)
    || (sequence > 0n && value.parentCommitId === null)
    || value.commitId === value.parentCommitId
  ) throw failure();
  return Object.freeze({
    protocolVersion: 1,
    anchorId,
    sequence: value.sequence,
    commitId: value.commitId,
    parentCommitId: value.parentCommitId,
    stateDigest: value.stateDigest,
  });
}

function parseContinuitySnapshot(
  value: unknown,
  anchorId: string,
): RelayV2ContinuityAnchorSnapshot {
  if (!isRecord(value)) throw failure();
  if (value.status === "uninitialized") {
    if (!hasExactKeys(value, [
      "protocolVersion",
      "status",
      "anchorId",
      "casToken",
    ]) || value.protocolVersion !== 1 || value.anchorId !== anchorId
      || typeof value.casToken !== "string" || value.casToken.length === 0) {
      throw failure();
    }
    return Object.freeze({
      protocolVersion: 1,
      status: "uninitialized",
      anchorId,
      casToken: value.casToken,
    });
  }
  if (value.status !== "committed" || !hasExactKeys(value, [
    "protocolVersion",
    "status",
    "anchorId",
    "casToken",
    "checkpoint",
  ]) || value.protocolVersion !== 1 || value.anchorId !== anchorId
    || typeof value.casToken !== "string" || value.casToken.length === 0) {
    throw failure();
  }
  return Object.freeze({
    protocolVersion: 1,
    status: "committed",
    anchorId,
    casToken: value.casToken,
    checkpoint: parseCheckpoint(value.checkpoint, anchorId),
  });
}

function readPersistedMetadata(
  database: SqliteDatabase,
  expected: Omit<PersistedMetadata, "issuerKeyring">,
): PersistedMetadata {
  if (
    onlyValue(database.prepare("PRAGMA user_version").get())
      !== DATABASE_SCHEMA_VERSION
    || JSON.stringify(sqliteObjects(database))
      !== JSON.stringify(["table:deployment_config", "table:owner_state"])
  ) throw failure();
  const candidate = row(database.prepare(`
    SELECT policy, deployment_id, machine_id_sha256, directory_device,
      directory_inode, issuer_url, relay_url, issuer_keyring_json
    FROM deployment_config WHERE singleton = 1
  `).get());
  if (
    candidate.policy !== POLICY
    || candidate.deployment_id !== expected.deploymentId
    || candidate.machine_id_sha256 !== expected.machineIdSha256
    || candidate.directory_device !== expected.directoryDevice
    || candidate.directory_inode !== expected.directoryInode
    || candidate.issuer_url !== expected.issuerUrl
    || candidate.relay_url !== expected.relayUrl
    || typeof candidate.issuer_keyring_json !== "string"
  ) throw failure();
  let keyringValue: unknown;
  try {
    keyringValue = JSON.parse(candidate.issuer_keyring_json);
  } catch {
    throw failure();
  }
  const issuerKeyring = parseRelayV2IssuerKeyring(keyringValue);
  if (
    issuerKeyring.issuerId !== `single-node-${expected.deploymentId}`
    || issuerKeyring.activeKey.kid
      !== `single-node-key-${expected.deploymentId}`
    || issuerKeyring.verifyOnlyKeys.length !== 0
    || issuerKeyring.retiredKids.length !== 0
  ) throw failure();
  const configCount = row(
    database.prepare("SELECT count(*) AS count FROM deployment_config").get(),
  ).count;
  const stateCount = row(
    database.prepare("SELECT count(*) AS count FROM owner_state").get(),
  ).count;
  if (configCount !== 1 || stateCount !== 1) throw failure();
  return Object.freeze({ ...expected, issuerKeyring });
}

function readCredentialRow(database: SqliteDatabase): CredentialRow {
  const candidate = row(database.prepare(`
    SELECT credential_generation, length(credential_state) AS byte_length,
      credential_state
    FROM owner_state WHERE singleton = 1
  `).get());
  if (
    !canonicalUint64(candidate.credential_generation)
    || (candidate.byte_length !== null
      && (!Number.isSafeInteger(candidate.byte_length)
        || (candidate.byte_length as number) < 0
        || (candidate.byte_length as number)
          > RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES))
  ) throw failure();
  if (candidate.credential_state === null) {
    if (candidate.credential_generation !== "0"
      || candidate.byte_length !== null) throw failure();
    return Object.freeze({ generation: "0", bytes: null });
  }
  if (!(candidate.credential_state instanceof Uint8Array)
    || candidate.byte_length !== candidate.credential_state.byteLength
    || candidate.credential_generation === "0") throw failure();
  return Object.freeze({
    generation: candidate.credential_generation,
    bytes: Uint8Array.from(candidate.credential_state),
  });
}

function readContinuityRow(
  database: SqliteDatabase,
  anchorId: string,
): ContinuityRow {
  const candidate = row(database.prepare(`
    SELECT continuity_generation, continuity_json
    FROM owner_state WHERE singleton = 1
  `).get());
  if (!canonicalUint64(candidate.continuity_generation)
    || typeof candidate.continuity_json !== "string") throw failure();
  let snapshotValue: unknown;
  try {
    snapshotValue = JSON.parse(candidate.continuity_json);
  } catch {
    throw failure();
  }
  const snapshot = parseContinuitySnapshot(snapshotValue, anchorId);
  if (
    (snapshot.status === "uninitialized"
      && candidate.continuity_generation !== "0")
    || (snapshot.status === "committed"
      && BigInt(candidate.continuity_generation)
        !== BigInt(snapshot.checkpoint.sequence) + 1n)
    || snapshot.casToken
      !== `single-node-cas-${candidate.continuity_generation}-${anchorId.slice("single-node-anchor-".length)}`
  ) throw failure();
  return Object.freeze({
    generation: candidate.continuity_generation,
    snapshot,
  });
}

class RelayV2BrokerSingleNodeSqliteOwner
implements RelayV2BrokerCredentialStateStore {
  readonly anchorId: string;
  readonly issuerKeyring: RelayV2IssuerKeyring;
  private readonly revisions = new WeakMap<object, RevisionOwner>();
  private storeTail: Promise<void> = Promise.resolve();
  private continuityTail: Promise<void> = Promise.resolve();
  private closing = false;
  private poisoned = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly database: SqliteDatabase,
    metadata: PersistedMetadata,
    private readonly directoryDescriptor: number,
  ) {
    this.anchorId = `single-node-anchor-${metadata.deploymentId}`;
    this.issuerKeyring = metadata.issuerKeyring;
    readCredentialRow(database);
    readContinuityRow(database, this.anchorId);
  }

  private requireOpen(): void {
    if (this.closing || this.poisoned) {
      throw new RelayV2BrokerCredentialStateStoreError("STORE_CLOSED");
    }
  }

  runExclusive<Result>(
    operation: <TransactionScope>(
      transaction: RelayV2BrokerCredentialStateTransaction<TransactionScope>,
    ) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    try {
      this.requireOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const transactionIdentity = Object.freeze({});
    const admitted = this.storeTail.then(async () => {
      this.requireOpen();
      let active = true;
      const requireActive = (): void => {
        this.requireOpen();
        if (!active) {
          throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
        }
      };
      const readCurrent = <TransactionScope>() => {
        requireActive();
        let current: CredentialRow;
        try {
          current = readCredentialRow(this.database);
        } catch {
          this.poisoned = true;
          throw new RelayV2BrokerCredentialStateStoreError("STORE_CORRUPT");
        }
        const revision = Object.freeze({});
        this.revisions.set(revision, Object.freeze({
          transactionIdentity,
          generation: current.generation,
        }));
        return current.bytes === null
          ? Object.freeze({
              outcome: "missing" as const,
              revision:
                revision as RelayV2BrokerCredentialStateRevision<TransactionScope>,
            })
          : Object.freeze({
              outcome: "present" as const,
              revision:
                revision as RelayV2BrokerCredentialStateRevision<TransactionScope>,
              bytes: Uint8Array.from(current.bytes),
            });
      };
      const transaction = Object.freeze({
        read: async () => readCurrent(),
        compareAndPublish: async <TransactionScope>(
          expected: RelayV2BrokerCredentialStateRevision<TransactionScope>,
          next: Uint8Array,
        ) => {
          requireActive();
          if (!(next instanceof Uint8Array)) {
            throw new RelayV2BrokerCredentialStateStoreError("INVALID_ARGUMENT");
          }
          if (next.byteLength > RELAY_V2_BROKER_CREDENTIAL_STATE_MAX_BYTES) {
            throw new RelayV2BrokerCredentialStateStoreError("STATE_TOO_LARGE");
          }
          const owner = this.revisions.get(expected as object);
          if (owner?.transactionIdentity !== transactionIdentity) {
            throw new RelayV2BrokerCredentialStateStoreError("INVALID_REVISION");
          }
          const current = readCredentialRow(this.database);
          if (current.bytes !== null
            && Buffer.from(current.bytes).equals(next)) {
            return Object.freeze({
              outcome: "already_same" as const,
              current: readCurrent<TransactionScope>(),
            });
          }
          if (owner.generation !== current.generation) {
            return Object.freeze({
              outcome: "conflict" as const,
              current: readCurrent<TransactionScope>(),
            });
          }
          const copied = Uint8Array.from(next);
          const generation = incrementUint64(current.generation);
          let committed = false;
          try {
            this.database.exec("BEGIN EXCLUSIVE");
            const result = this.database.prepare(`
              UPDATE owner_state
              SET credential_generation = ?, credential_state = ?
              WHERE singleton = 1 AND credential_generation = ?
            `).run(generation, copied, current.generation);
            if (result.changes !== 1 && result.changes !== 1n) {
              this.database.exec("ROLLBACK");
              return Object.freeze({
                outcome: "conflict" as const,
                current: readCurrent<TransactionScope>(),
              });
            }
            this.database.exec("COMMIT");
            committed = true;
          } catch {
            if (!committed) {
              try { this.database.exec("ROLLBACK"); } catch {}
            }
            this.poisoned = true;
            return Object.freeze({ outcome: "uncertain" as const });
          } finally {
            copied.fill(0);
          }
          return Object.freeze({
            outcome: "swapped" as const,
            current: readCurrent<TransactionScope>(),
          });
        },
      }) as RelayV2BrokerCredentialStateTransaction<unknown>;
      try {
        return await operation(transaction);
      } finally {
        active = false;
      }
    });
    this.storeTail = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  performContinuityOperation<Result>(operation: () => Result): Promise<Result> {
    const admitted = this.continuityTail.then(() => {
      this.requireOpen();
      return operation();
    });
    this.continuityTail = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  readContinuity(): RelayV2ContinuityAnchorSnapshot {
    return cloneJson(readContinuityRow(this.database, this.anchorId).snapshot);
  }

  compareAndSwapContinuity(
    expectedValue: unknown,
    nextValue: unknown,
  ): Readonly<{
    protocolVersion: 1;
    outcome: "swapped" | "conflict";
    current: RelayV2ContinuityAnchorSnapshot;
  }> {
    const current = readContinuityRow(this.database, this.anchorId);
    const expected = parseContinuitySnapshot(expectedValue, this.anchorId);
    const next = parseCheckpoint(nextValue, this.anchorId);
    if (JSON.stringify(expected) !== JSON.stringify(current.snapshot)) {
      return Object.freeze({
        protocolVersion: 1,
        outcome: "conflict",
        current: cloneJson(current.snapshot),
      });
    }
    const validSuccessor = current.snapshot.status === "uninitialized"
      ? next.sequence === "0" && next.parentCommitId === null
      : BigInt(next.sequence) === BigInt(current.snapshot.checkpoint.sequence) + 1n
        && next.parentCommitId === current.snapshot.checkpoint.commitId;
    if (!validSuccessor) throw failure();
    const generation = incrementUint64(current.generation);
    const snapshot: RelayV2ContinuityAnchorSnapshot = Object.freeze({
      protocolVersion: 1,
      status: "committed",
      anchorId: this.anchorId,
      casToken:
        `single-node-cas-${generation}-${this.anchorId.slice("single-node-anchor-".length)}`,
      checkpoint: next,
    });
    let committed = false;
    try {
      this.database.exec("BEGIN EXCLUSIVE");
      const result = this.database.prepare(`
        UPDATE owner_state
        SET continuity_generation = ?, continuity_json = ?
        WHERE singleton = 1 AND continuity_generation = ?
      `).run(generation, JSON.stringify(snapshot), current.generation);
      if (result.changes !== 1 && result.changes !== 1n) {
        this.database.exec("ROLLBACK");
        return Object.freeze({
          protocolVersion: 1,
          outcome: "conflict",
          current: this.readContinuity(),
        });
      }
      this.database.exec("COMMIT");
      committed = true;
      return Object.freeze({
        protocolVersion: 1,
        outcome: "swapped",
        current: cloneJson(snapshot),
      });
    } catch {
      if (!committed) {
        try { this.database.exec("ROLLBACK"); } catch {}
      }
      this.poisoned = true;
      throw failure();
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.all([
      this.storeTail,
      this.continuityTail,
    ]).then(() => {
      let failed = false;
      try { this.database.close(); } catch { failed = true; }
      try { closeSync(this.directoryDescriptor); } catch { failed = true; }
      if (failed) throw failure();
    });
    return this.closePromise;
  }
}

async function openPersistentOwner(
  options: CapturedOptions,
  signal: AbortSignal,
): Promise<RelayV2BrokerSingleNodeSqliteOwner> {
  const directory = openStateDirectory(options.stateDirectory);
  let database: SqliteDatabase | null = null;
  try {
    verifyDedicatedDirectoryEntries(options.stateDirectory, directory.euid);
    const databasePath = prepareDatabaseFile(
      options.stateDirectory,
      directory.descriptor,
      directory.euid,
    );
    // Keep the built-in specifier opaque to the repository-wide Node 20
    // bundling target; this lane has already enforced Node 22.16+ above.
    const sqliteSpecifier = `node:${"sqlite"}`;
    const sqlite = await import(sqliteSpecifier) as unknown as SqliteModule;
    if (signal.aborted || typeof sqlite.DatabaseSync !== "function") {
      throw failure();
    }
    database = new sqlite.DatabaseSync(databasePath);
    configureDatabase(database);

    const machineIdSha256 = readMachineIdentity();
    const objects = sqliteObjects(database);
    let metadata: PersistedMetadata;
    if (objects.length === 0) {
      metadata = initializeDatabase(database, {
        deploymentId: randomBytes(16).toString("hex"),
        machineIdSha256,
        directoryDevice: directory.device,
        directoryInode: directory.inode,
        issuerUrl: options.issuerUrl,
        relayUrl: options.relayUrl,
      });
    } else {
      const identity = row(database.prepare(`
        SELECT deployment_id FROM deployment_config WHERE singleton = 1
      `).get());
      if (typeof identity.deployment_id !== "string"
        || !/^[0-9a-f]{32}$/.test(identity.deployment_id)) throw failure();
      metadata = readPersistedMetadata(database, {
        deploymentId: identity.deployment_id,
        machineIdSha256,
        directoryDevice: directory.device,
        directoryInode: directory.inode,
        issuerUrl: options.issuerUrl,
        relayUrl: options.relayUrl,
      });
    }
    const after = lstatSync(databasePath, { bigint: true });
    assertPrivateFile(after, directory.euid, DATABASE_MAX_BYTES, false);
    return new RelayV2BrokerSingleNodeSqliteOwner(
      database,
      metadata,
      directory.descriptor,
    );
  } catch {
    if (database !== null) {
      try { database.close(); } catch {}
    }
    try { closeSync(directory.descriptor); } catch {}
    throw failure();
  }
}

function exactReadRequest(
  value: RelayV2ContinuityAnchorReadRequest,
  anchorId: string,
): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["protocolVersion", "anchorId", "signal"])
    && value.protocolVersion === 1
    && value.anchorId === anchorId
    && value.signal instanceof AbortSignal;
}

function exactCasRequest(
  value: RelayV2ContinuityAnchorCasRequest,
  anchorId: string,
): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      "protocolVersion",
      "anchorId",
      "expected",
      "next",
      "signal",
    ])
    && value.protocolVersion === 1
    && value.anchorId === anchorId
    && value.signal instanceof AbortSignal;
}

function coLocatedContinuityAuthority(
  owner: RelayV2BrokerSingleNodeSqliteOwner,
): RelayV2MonotonicCasAuthority {
  return Object.freeze({
    read(request: RelayV2ContinuityAnchorReadRequest) {
      if (!exactReadRequest(request, owner.anchorId)
        || request.signal.aborted) throw failure();
      return owner.performContinuityOperation(() => {
        if (request.signal.aborted) throw failure();
        return owner.readContinuity();
      });
    },
    compareAndSwap(request: RelayV2ContinuityAnchorCasRequest) {
      if (!exactCasRequest(request, owner.anchorId)
        || request.signal.aborted) throw failure();
      return owner.performContinuityOperation(() => {
        if (request.signal.aborted) throw failure();
        return owner.compareAndSwapContinuity(
          request.expected,
          request.next,
        );
      });
    },
  });
}

function credentialAuthorityOpener(
  owner: RelayV2BrokerSingleNodeSqliteOwner,
): RelayV2BrokerShippingNonProductionCredentialAuthorityOpener {
  const continuityAuthority = coLocatedContinuityAuthority(owner);
  let available = true;
  return Object.freeze(async (input: Readonly<{
    liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
    genesis: RelayV2BrokerCredentialAuthorityGenesis;
  }>) => {
    if (!available
      || !Object.isFrozen(input)
      || !isRecord(input)
      || !hasExactKeys(input, ["liveAuthorizationFence", "genesis"])) {
      throw failure();
    }
    available = false;
    // Calling the canonical authority is the ownership-transfer cut. Its open
    // path owns store closure on success and rejection.
    return RelayV2BrokerCredentialAuthority.open({
      store: owner,
      continuityAnchor: Object.freeze({
        anchorId: owner.anchorId,
        authority: continuityAuthority,
        operationTimeoutMs: 5_000,
        maxPendingOperations: 4,
      }),
      genesis: input.genesis,
      liveAuthorizationFence: input.liveAuthorizationFence,
    });
  });
}

function wrappedHandle(
  handle: RelayV2BrokerShippingRootHandle,
  owner: RelayV2BrokerSingleNodeSqliteOwner,
): RelayV2BrokerShippingRootHandle {
  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    host: handle.host,
    port: handle.port,
    issuerUrl: handle.issuerUrl,
    relayUrl: handle.relayUrl,
    admin: handle.admin,
    shutdown() {
      if (closePromise === null) {
        closePromise = handle.shutdown().finally(() => owner.close());
      }
      return closePromise;
    },
  });
}

/**
 * Explicit non-production Linux x64 single-node lane. The SQLite owner is
 * intentionally co-located and therefore is not E0 or production
 * qualification. It injects the existing storage/continuity/keyring ports
 * into the canonical Broker shipping root and may forward one explicitly
 * supplied optional Agent routing receipt; omission remains default-off.
 */
export async function startRelayV2BrokerSingleNodeSelfHosted(
  optionsInput: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<RelayV2BrokerShippingRootHandle> {
  const options = captureOptions(optionsInput);
  if (
    process.platform !== "linux"
    || process.arch !== "x64"
    || !nodeVersionSupported()
    || !(signal instanceof AbortSignal)
    || signal.aborted
  ) throw failure();

  const key = readRelayV2BrokerDevelopmentTlsFile(options.tlsKeyPath);
  let certificate: Buffer;
  try {
    certificate =
      readRelayV2BrokerDevelopmentTlsFile(options.tlsCertificatePath);
  } catch (error) {
    key.fill(0);
    throw error;
  }
  let tlsDisposed = false;
  const disposeTls = (): void => {
    if (tlsDisposed) return;
    tlsDisposed = true;
    key.fill(0);
    certificate.fill(0);
  };

  let owner: RelayV2BrokerSingleNodeSqliteOwner | null = null;
  try {
    if (signal.aborted) throw failure();
    owner = await openPersistentOwner(options, signal);
    if (signal.aborted) throw failure();
    const profile = Object.freeze({
      configVersion: 1 as const,
      listen: Object.freeze({ host: options.host, port: options.port }),
      issuerUrl: options.issuerUrl,
      relayUrl: options.relayUrl,
      trustedHome: options.stateDirectory,
      tls: Object.freeze({
        keyReference: TLS_KEY_REFERENCE,
        certificateReference: TLS_CERTIFICATE_REFERENCE,
      }),
      issuerKeyringReference: KEYRING_REFERENCE,
      nonProductionCredentialPolicy:
        RELAY_V2_BROKER_SINGLE_NODE_SELF_HOSTED_POLICY,
    });
    const privilegedResolver = Object.freeze({
      resolveIssuerKeyring(reference: string) {
        if (reference !== KEYRING_REFERENCE || owner === null) throw failure();
        return owner.issuerKeyring;
      },
      resolveTlsMaterial(references: Readonly<{
        keyReference: string;
        certificateReference: string;
      }>) {
        if (
          tlsDisposed
          || references.keyReference !== TLS_KEY_REFERENCE
          || references.certificateReference !== TLS_CERTIFICATE_REFERENCE
        ) throw failure();
        return Object.freeze({
          key,
          cert: certificate,
          dispose: disposeTls,
        });
      },
    });
    const handle = await startRelayV2BrokerShippingRoot(
      profile,
      Object.freeze({
        privilegedResolver,
        nonProductionCredentialAuthorityOpener:
          credentialAuthorityOpener(owner),
        ...(options.agentTranscriptLifecycleReadiness === undefined
          ? {}
          : {
              agentTranscriptLifecycleReadiness:
                options.agentTranscriptLifecycleReadiness,
            }),
        ...(options.agentChatReadiness === undefined
          ? {}
          : {
              agentChatReadiness:
                options.agentChatReadiness,
            }),
        ...(options.larkBindingsReadiness === undefined
          ? {}
          : {
              larkBindingsReadiness:
                options.larkBindingsReadiness,
            }),
      }),
    );
    if (signal.aborted) {
      await handle.shutdown();
      throw failure();
    }
    return wrappedHandle(handle, owner);
  } catch {
    if (owner !== null) {
      try { await owner.close(); } catch {}
    }
    throw failure();
  } finally {
    disposeTls();
  }
}
