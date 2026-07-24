import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  readRelayV2BrokerShippingProfile,
  startRelayV2BrokerShippingRoot,
  type RelayV2BrokerShippingDeploymentInputs,
  type RelayV2BrokerShippingPrivilegedResolver,
  type RelayV2BrokerShippingProfile,
  type RelayV2BrokerShippingRootHandle,
  type RelayV2BrokerShippingTlsMaterial,
  type RelayV2BrokerShippingTlsReferences,
} from "./brokerShippingRoot.js";
import {
  relayV2BrokerCredentialStateStoreNativeLoader,
} from "./brokerCredentialStateStoreLoader.js";
import {
  createRelayV2ExternalContinuityAuthorityNodeAttemptProvider,
  type RelayV2ExternalContinuityAttemptMaterialResolver,
  type RelayV2ExternalContinuityAttemptMutualTlsCredentialMaterial,
  type RelayV2ExternalContinuityAttemptTrustMaterial,
  type RelayV2ExternalContinuityAttemptWorkloadCredentialMaterial,
} from "./externalContinuityAuthorityNodeAttemptProvider.js";
import type { RelayV2ExternalContinuityAuthenticationMode } from "./externalContinuityAuthorityConfig.js";
import {
  parseRelayV2IssuerKeyring,
  type RelayV2IssuerKeyring,
} from "./issuer.js";

/**
 * The single default-off trusted deployment activation/source owner for the
 * Relay v2 broker shipping root. Sensitive material never comes from arbitrary
 * paths, argv, environment, or a dynamic module: every reference identifier in
 * the already-validated reference-only profile maps to one fixed filename
 * under `<trustedHome>/.tmux-worktree/relay-v2-broker-deployment/`:
 *
 *   tls/<keyReference>.key.pem            TLS private key
 *   tls/<certificateReference>.cert.pem   TLS certificate
 *   tls/<trustReference>.ca.pem           TLS CA bundle (only when referenced)
 *   issuer/<issuerKeyringReference>.keyring.json
 *   e0/<tlsTrustReference>.ca.pem         E0 CA bundle
 *   e0/<credentialReference>.headers.json E0 workload-identity headers
 *   e0/<credentialReference>.cert.pem     E0 mutual-TLS certificate
 *   e0/<credentialReference>.key.pem      E0 mutual-TLS private key
 *
 * Every file is secure-opened fd-bound (regular file, no symlink, owner,
 * exact 0600, single link, bounded size) under exact 0700 private directories;
 * the source never creates, chmods, or writes anything. An eager validation
 * pass secure-reads every material file (schema checks only for the keyring
 * and workload-headers JSON; PEM/CA/cert/key receive only the bounded secure
 * read) before any native open, mutation, or listener, and discards the bytes
 * immediately; the privileged resolvers re-read freshly on every call and zero
 * their buffers on dispose. This owner reuses the existing fixed native
 * loader and the Node E0 attempt provider over the system Node stack, creates
 * no second authority/E0/native owner, never falls back to Relay v1, and
 * advertises no readiness or capability; native `qualifiedRecords=[]` and the
 * overall NO-GO are unchanged.
 */

export type RelayV2BrokerShippingDeploymentSourceErrorCode =
  | "RELAY_V2_BROKER_DEPLOYMENT_PLATFORM_UNSUPPORTED"
  | "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE"
  | "RELAY_V2_BROKER_DEPLOYMENT_INVALID";

export class RelayV2BrokerShippingDeploymentSourceError extends Error {
  constructor(readonly code: RelayV2BrokerShippingDeploymentSourceErrorCode) {
    super(messageForCode(code));
    this.name = "RelayV2BrokerShippingDeploymentSourceError";
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ACCOUNT_STATE_DIRECTORY = ".tmux-worktree";
const DEPLOYMENT_DIRECTORY = "relay-v2-broker-deployment";

const MAX_TLS_MATERIAL_BYTES = 16_384;
const MAX_CA_BUNDLE_BYTES = 32_768;
const MAX_KEYRING_BYTES = 65_536;
const MAX_HEADERS_BYTES = 16_384;
const MAX_CA_ENTRIES = 8;
const MAX_HEADER_COUNT = 8;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 4_096;

const BEGIN_CERTIFICATE = "-----BEGIN CERTIFICATE-----";
const END_CERTIFICATE = "-----END CERTIFICATE-----";

type MaterialSubdirectory = "tls" | "issuer" | "e0";

function messageForCode(code: RelayV2BrokerShippingDeploymentSourceErrorCode): string {
  switch (code) {
    case "RELAY_V2_BROKER_DEPLOYMENT_PLATFORM_UNSUPPORTED":
      return "Relay v2 broker deployment source is unsupported on this platform";
    case "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE":
      return "Relay v2 broker deployment source is unavailable";
    case "RELAY_V2_BROKER_DEPLOYMENT_INVALID":
      return "Relay v2 broker deployment source is invalid";
  }
}

function unavailable(): RelayV2BrokerShippingDeploymentSourceError {
  return new RelayV2BrokerShippingDeploymentSourceError(
    "RELAY_V2_BROKER_DEPLOYMENT_UNAVAILABLE",
  );
}

function invalid(): RelayV2BrokerShippingDeploymentSourceError {
  return new RelayV2BrokerShippingDeploymentSourceError(
    "RELAY_V2_BROKER_DEPLOYMENT_INVALID",
  );
}

function isDeploymentSourceError(
  error: unknown,
): error is RelayV2BrokerShippingDeploymentSourceError {
  return error instanceof RelayV2BrokerShippingDeploymentSourceError;
}

function supportedEuid(): bigint {
  if ((process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
    || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new RelayV2BrokerShippingDeploymentSourceError(
      "RELAY_V2_BROKER_DEPLOYMENT_PLATFORM_UNSUPPORTED",
    );
  }
  return BigInt(process.geteuid());
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 128
    && IDENTIFIER.test(value);
}

function modeOf(information: BigIntStats): number {
  return Number(information.mode & 0o7777n);
}

function statPath(path: string): BigIntStats {
  return lstatSync(path, { bigint: true });
}

function assertDirectory(
  information: BigIntStats,
  euid: bigint,
  exactPrivate: boolean,
): void {
  if (!information.isDirectory()
    || information.isSymbolicLink()
    || information.uid !== euid) throw unavailable();
  const mode = modeOf(information);
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) throw unavailable();
}

function statDirectory(path: string, euid: bigint, exactPrivate: boolean): void {
  let information: BigIntStats;
  try {
    information = statPath(path);
  } catch {
    throw unavailable();
  }
  assertDirectory(information, euid, exactPrivate);
}

/**
 * Validates the fixed directory chain down to one material subdirectory. Only
 * trustedHome itself is canonicalized; every child is proven a non-symlink
 * directory, so the joined path stays canonical.
 */
function deploymentSubdirectory(
  trustedHome: string,
  subdirectory: MaterialSubdirectory,
  euid: bigint,
): string {
  let home: BigIntStats;
  try {
    home = statPath(trustedHome);
  } catch {
    throw unavailable();
  }
  if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== euid) {
    throw unavailable();
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(trustedHome);
  } catch {
    throw unavailable();
  }
  if (canonical !== trustedHome) throw unavailable();
  const accountState = join(trustedHome, ACCOUNT_STATE_DIRECTORY);
  statDirectory(accountState, euid, false);
  const root = join(accountState, DEPLOYMENT_DIRECTORY);
  statDirectory(root, euid, true);
  const directory = join(root, subdirectory);
  statDirectory(directory, euid, true);
  return directory;
}

function assertMaterialFile(
  information: BigIntStats,
  euid: bigint,
  maxBytes: number,
): void {
  if (!information.isFile()
    || information.isSymbolicLink()
    || information.uid !== euid
    || modeOf(information) !== 0o600
    || information.nlink !== 1n
    || information.size <= 0n
    || information.size > BigInt(maxBytes)) throw unavailable();
}

/**
 * Reads one material file fd-bound: lstat checks, O_RDONLY|O_NOFOLLOW open,
 * fstat re-check plus dev/ino identity against the lstat, exact-size read, and
 * an explicit main close. Any failure path zeroes the partially read buffer
 * before rethrowing; a main-close failure zeroes it too and surfaces only as
 * the redacted unavailable error. The source never creates, chmods, or writes.
 */
function secureReadMaterial(
  trustedHome: string,
  subdirectory: MaterialSubdirectory,
  identifier: string,
  suffix: string,
  maxBytes: number,
): Buffer {
  const euid = supportedEuid();
  if (!isIdentifier(identifier)) throw invalid();
  const directory = deploymentSubdirectory(trustedHome, subdirectory, euid);
  const path = join(directory, `${identifier}${suffix}`);
  let before: BigIntStats;
  try {
    before = statPath(path);
  } catch {
    throw unavailable();
  }
  assertMaterialFile(before, euid, maxBytes);
  let descriptor = -1;
  let bytes: Buffer | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    assertMaterialFile(opened, euid, maxBytes);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw unavailable();
    }
    const size = Number(opened.size);
    bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read <= 0) throw unavailable();
      offset += read;
    }
    closeSync(descriptor);
    descriptor = -1;
    const transferred = bytes;
    bytes = null;
    return transferred;
  } catch (error) {
    if (bytes !== null) bytes.fill(0);
    if (isDeploymentSourceError(error)) throw error;
    throw unavailable();
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function parseJsonMaterial(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
}

function parseKeyringMaterial(bytes: Buffer): RelayV2IssuerKeyring {
  try {
    return parseRelayV2IssuerKeyring(parseJsonMaterial(bytes));
  } catch (error) {
    if (isDeploymentSourceError(error)) throw error;
    throw invalid();
  }
}

/** Closed-schema workload headers: exactly `{"authenticationHeaders": {...}}`. */
function parseWorkloadHeadersMaterial(bytes: Buffer): Record<string, string> {
  const parsed = parseJsonMaterial(bytes);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const outerKeys = Object.keys(parsed);
  if (outerKeys.length !== 1 || outerKeys[0] !== "authenticationHeaders") throw invalid();
  const record = (parsed as Record<string, unknown>).authenticationHeaders;
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw invalid();
  const names = Object.keys(record);
  if (names.length > MAX_HEADER_COUNT) throw invalid();
  const headers: Record<string, string> = {};
  for (const name of names) {
    const value = (record as Record<string, unknown>)[name];
    if (Buffer.byteLength(name, "utf8") > MAX_HEADER_NAME_BYTES
      || typeof value !== "string"
      || Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES) throw invalid();
    headers[name] = value;
  }
  return headers;
}

/**
 * Splits a PEM CA bundle into individual certificate blocks so every entry
 * stays within the single-material bound the E0 attempt provider enforces.
 * Anything but whitespace outside BEGIN/END blocks is invalid.
 */
function splitCertificateAuthorities(bytes: Buffer): Buffer[] {
  const entries: Buffer[] = [];
  try {
    let rest = bytes.toString("utf8");
    for (;;) {
      const begin = rest.indexOf(BEGIN_CERTIFICATE);
      if (begin === -1) {
        if (rest.trim() !== "") throw invalid();
        break;
      }
      if (rest.slice(0, begin).trim() !== "") throw invalid();
      const end = rest.indexOf(END_CERTIFICATE, begin + BEGIN_CERTIFICATE.length);
      if (end === -1) throw invalid();
      const blockEnd = end + END_CERTIFICATE.length;
      const entry = Buffer.from(rest.slice(begin, blockEnd), "utf8");
      if (entry.byteLength > MAX_TLS_MATERIAL_BYTES) throw invalid();
      entries.push(entry);
      if (entries.length > MAX_CA_ENTRIES) throw invalid();
      rest = rest.slice(blockEnd);
    }
    if (entries.length === 0) throw invalid();
    return entries;
  } catch (error) {
    for (const entry of entries) entry.fill(0);
    if (isDeploymentSourceError(error)) throw error;
    throw invalid();
  }
}

interface ActivationProfile {
  readonly trustedHome: string;
  readonly tlsKeyReference: string;
  readonly tlsCertificateReference: string;
  readonly tlsTrustReference: string | null;
  readonly issuerKeyringReference: string;
  readonly e0AuthenticationMode: RelayV2ExternalContinuityAuthenticationMode;
  readonly e0CredentialReference: string;
  readonly e0TlsTrustReference: string;
}

/**
 * Re-checks the already-captured profile defensively: every reference used by
 * this owner must be a strict identifier (single path component, no separator,
 * no leading dot, no traversal), and trustedHome an absolute path.
 */
function captureActivationProfile(value: RelayV2BrokerShippingProfile): ActivationProfile {
  const candidate: unknown = value;
  if (candidate === null || typeof candidate !== "object") throw invalid();
  const record = candidate as Record<string, unknown>;
  const trustedHome = record.trustedHome;
  const tls = record.tls as Record<string, unknown> | null;
  const externalContinuity = record.externalContinuity as Record<string, unknown> | null;
  if (typeof trustedHome !== "string"
    || !isAbsolute(trustedHome)
    || trustedHome.includes("\0")) throw invalid();
  if (tls === null || typeof tls !== "object"
    || !isIdentifier(tls.keyReference)
    || !isIdentifier(tls.certificateReference)
    || (tls.trustReference !== undefined && !isIdentifier(tls.trustReference))) throw invalid();
  if (!isIdentifier(record.issuerKeyringReference)) throw invalid();
  if (externalContinuity === null || typeof externalContinuity !== "object") throw invalid();
  const mode = externalContinuity.authenticationMode;
  if (mode !== "mutual_tls" && mode !== "workload_identity") throw invalid();
  if (!isIdentifier(externalContinuity.credentialReference)
    || !isIdentifier(externalContinuity.tlsTrustReference)) throw invalid();
  return Object.freeze({
    trustedHome,
    tlsKeyReference: tls.keyReference,
    tlsCertificateReference: tls.certificateReference,
    tlsTrustReference: tls.trustReference === undefined ? null : tls.trustReference,
    issuerKeyringReference: record.issuerKeyringReference,
    e0AuthenticationMode: mode,
    e0CredentialReference: externalContinuity.credentialReference,
    e0TlsTrustReference: externalContinuity.tlsTrustReference,
  });
}

function discardAfterValidation(bytes: Buffer, validate?: (bytes: Buffer) => unknown): void {
  try {
    validate?.(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Eager validation pass: bounded secure read of every material file before
 * any native open, mutation, or listener. Schema/content validation covers
 * only the keyring JSON and workload headers JSON; TLS key/cert, CA bundles,
 * and mutual-TLS cert/key receive only the bounded secure read (bytes bound
 * and non-empty), with no PEM or structural validation here. Read bytes are
 * zeroed immediately and never retained.
 */
function validateDeploymentEagerly(activation: ActivationProfile): void {
  const home = activation.trustedHome;
  discardAfterValidation(secureReadMaterial(
    home, "tls", activation.tlsKeyReference, ".key.pem", MAX_TLS_MATERIAL_BYTES,
  ));
  discardAfterValidation(secureReadMaterial(
    home, "tls", activation.tlsCertificateReference, ".cert.pem", MAX_TLS_MATERIAL_BYTES,
  ));
  if (activation.tlsTrustReference !== null) {
    discardAfterValidation(secureReadMaterial(
      home, "tls", activation.tlsTrustReference, ".ca.pem", MAX_CA_BUNDLE_BYTES,
    ));
  }
  discardAfterValidation(
    secureReadMaterial(
      home, "issuer", activation.issuerKeyringReference, ".keyring.json", MAX_KEYRING_BYTES,
    ),
    parseKeyringMaterial,
  );
  discardAfterValidation(secureReadMaterial(
    home, "e0", activation.e0TlsTrustReference, ".ca.pem", MAX_CA_BUNDLE_BYTES,
  ));
  if (activation.e0AuthenticationMode === "workload_identity") {
    discardAfterValidation(
      secureReadMaterial(
        home, "e0", activation.e0CredentialReference, ".headers.json", MAX_HEADERS_BYTES,
      ),
      parseWorkloadHeadersMaterial,
    );
  } else {
    discardAfterValidation(secureReadMaterial(
      home, "e0", activation.e0CredentialReference, ".cert.pem", MAX_TLS_MATERIAL_BYTES,
    ));
    discardAfterValidation(secureReadMaterial(
      home, "e0", activation.e0CredentialReference, ".key.pem", MAX_TLS_MATERIAL_BYTES,
    ));
  }
}

function createPrivilegedResolver(
  activation: ActivationProfile,
): RelayV2BrokerShippingPrivilegedResolver {
  const home = activation.trustedHome;
  return Object.freeze({
    resolveTlsMaterial(references: RelayV2BrokerShippingTlsReferences): RelayV2BrokerShippingTlsMaterial {
      const candidate: unknown = references;
      if (candidate === null || typeof candidate !== "object") throw invalid();
      const captured = candidate as Record<string, unknown>;
      if (captured.keyReference !== activation.tlsKeyReference
        || captured.certificateReference !== activation.tlsCertificateReference
        || (captured.trustReference ?? null) !== activation.tlsTrustReference) throw invalid();
      const key = secureReadMaterial(
        home, "tls", activation.tlsKeyReference, ".key.pem", MAX_TLS_MATERIAL_BYTES,
      );
      let cert: Buffer | null = null;
      let ca: Buffer | null = null;
      try {
        cert = secureReadMaterial(
          home, "tls", activation.tlsCertificateReference, ".cert.pem", MAX_TLS_MATERIAL_BYTES,
        );
        ca = activation.tlsTrustReference === null
          ? null
          : secureReadMaterial(
              home, "tls", activation.tlsTrustReference, ".ca.pem", MAX_CA_BUNDLE_BYTES,
            );
      } catch (error) {
        key.fill(0);
        cert?.fill(0);
        ca?.fill(0);
        throw error;
      }
      const held = ca === null ? [key, cert] : [key, cert, ca];
      let disposed = false;
      return {
        key,
        cert,
        ...(ca === null ? {} : { ca }),
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const buffer of held) buffer.fill(0);
        },
      };
    },
    resolveIssuerKeyring(reference: string): RelayV2IssuerKeyring {
      if (reference !== activation.issuerKeyringReference) throw invalid();
      const bytes = secureReadMaterial(
        home, "issuer", activation.issuerKeyringReference, ".keyring.json", MAX_KEYRING_BYTES,
      );
      try {
        return parseKeyringMaterial(bytes);
      } finally {
        bytes.fill(0);
      }
    },
  });
}

function createE0Resolver(
  activation: ActivationProfile,
): RelayV2ExternalContinuityAttemptMaterialResolver {
  const home = activation.trustedHome;
  function resolveTrust(reference: string): RelayV2ExternalContinuityAttemptTrustMaterial {
    if (reference !== activation.e0TlsTrustReference) throw invalid();
    const bytes = secureReadMaterial(
      home, "e0", activation.e0TlsTrustReference, ".ca.pem", MAX_CA_BUNDLE_BYTES,
    );
    let certificateAuthorities: Buffer[];
    try {
      certificateAuthorities = splitCertificateAuthorities(bytes);
    } finally {
      bytes.fill(0);
    }
    let disposed = false;
    return {
      certificateAuthorities,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const entry of certificateAuthorities) entry.fill(0);
      },
    };
  }
  function resolveCredential(
    reference: string,
    mode: "workload_identity",
  ): RelayV2ExternalContinuityAttemptWorkloadCredentialMaterial;
  function resolveCredential(
    reference: string,
    mode: "mutual_tls",
  ): RelayV2ExternalContinuityAttemptMutualTlsCredentialMaterial;
  function resolveCredential(
    reference: string,
    mode: RelayV2ExternalContinuityAuthenticationMode,
  ): RelayV2ExternalContinuityAttemptWorkloadCredentialMaterial
    | RelayV2ExternalContinuityAttemptMutualTlsCredentialMaterial {
    if (reference !== activation.e0CredentialReference
      || mode !== activation.e0AuthenticationMode) throw invalid();
    if (mode === "workload_identity") {
      const bytes = secureReadMaterial(
        home, "e0", activation.e0CredentialReference, ".headers.json", MAX_HEADERS_BYTES,
      );
      let authenticationHeaders: Record<string, string>;
      try {
        authenticationHeaders = parseWorkloadHeadersMaterial(bytes);
      } finally {
        bytes.fill(0);
      }
      let disposed = false;
      return {
        authenticationHeaders,
        dispose() {
          if (disposed) return;
          disposed = true;
        },
      };
    }
    const clientCertificate = secureReadMaterial(
      home, "e0", activation.e0CredentialReference, ".cert.pem", MAX_TLS_MATERIAL_BYTES,
    );
    let clientKey: Buffer;
    try {
      clientKey = secureReadMaterial(
        home, "e0", activation.e0CredentialReference, ".key.pem", MAX_TLS_MATERIAL_BYTES,
      );
    } catch (error) {
      clientCertificate.fill(0);
      throw error;
    }
    let disposed = false;
    return {
      clientCertificate,
      clientKey,
      dispose() {
        if (disposed) return;
        disposed = true;
        clientCertificate.fill(0);
        clientKey.fill(0);
      },
    };
  }
  return Object.freeze({ resolveTrust, resolveCredential });
}

/**
 * Shared file-backed resolver construction used by trusted activation. It
 * performs the same activation capture and eager validation pass, but it is
 * not a shipping activation path: it binds no native loader, attempt provider,
 * or listener and produces no listen capability. Isolated tests combine these
 * resolvers with the existing injectable boundaries (the E0 attempt provider
 * factory's documented `httpsRequest` test seam and the injectable shipping
 * root); the CLI and production activation never do.
 */
export function createRelayV2BrokerDeploymentFileResolvers(
  profile: RelayV2BrokerShippingProfile,
): Readonly<{
  privilegedResolver: RelayV2BrokerShippingPrivilegedResolver;
  externalContinuityMaterialResolver: RelayV2ExternalContinuityAttemptMaterialResolver;
}> {
  const activation = captureActivationProfile(profile);
  validateDeploymentEagerly(activation);
  return Object.freeze({
    privilegedResolver: createPrivilegedResolver(activation),
    externalContinuityMaterialResolver: createE0Resolver(activation),
  });
}

/**
 * Builds the frozen deployment inputs for the existing shipping root from the
 * profile's fixed trustedHome namespace: always the fixed native loader, the
 * real Node E0 attempt provider (system Node stack) over the file-backed
 * frozen resolver, and the file-backed frozen privileged resolver. The eager
 * validation pass fails closed before anything here can open, mutate, or
 * listen. There is no caller-supplied seam: qualification cannot be faked
 * through this boundary.
 */
export function createRelayV2BrokerShippingDeploymentInputs(
  profile: RelayV2BrokerShippingProfile,
): RelayV2BrokerShippingDeploymentInputs {
  const { privilegedResolver, externalContinuityMaterialResolver } =
    createRelayV2BrokerDeploymentFileResolvers(profile);
  return Object.freeze({
    privilegedResolver,
    externalContinuityAttemptProvider:
      createRelayV2ExternalContinuityAuthorityNodeAttemptProvider({
        resolver: externalContinuityMaterialResolver,
      }),
    nativeLoader: relayV2BrokerCredentialStateStoreNativeLoader,
  });
}

/**
 * CLI-facing trusted activation: reads the reference-only profile through the
 * shipping root's own reader, derives the deployment inputs from the fixed
 * trustedHome namespace, and hands both to the existing shipping root. Any
 * profile, identifier, ownership, material, E0, or native failure fails closed
 * before any listener — never falling back to Relay v1.
 */
export async function startRelayV2BrokerShippingFromTrustedDeployment(
  profilePath: string,
): Promise<RelayV2BrokerShippingRootHandle> {
  const profile = readRelayV2BrokerShippingProfile(profilePath);
  const inputs = createRelayV2BrokerShippingDeploymentInputs(profile);
  return startRelayV2BrokerShippingRoot(profile, inputs);
}
