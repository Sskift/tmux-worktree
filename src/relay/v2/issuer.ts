import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import {
  decodeCanonicalRelayV2Base64Url,
  encodeRelayV2AccessToken,
  isRelayV2AuthIdentifier,
  RELAY_V2_ACCESS_TOKEN_AUDIENCE,
  RELAY_V2_MAX_ACCESS_TTL_SECONDS,
  RELAY_V2_MAX_CLOCK_SKEW_SECONDS,
  type RelayV2AccessRole,
  type RelayV2AccessTokenClaims,
  verifyRelayV2AccessToken,
} from "./token.js";

export const RELAY_V2_ISSUER_KEYRING_VERSION = 1 as const;
const MAX_KEYRING_BYTES = 1 * 1024 * 1024;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 64;

export interface RelayV2IssuerActiveKey {
  kid: string;
  secretBase64url: string;
  createdAtSeconds: number;
  maxIssuedExpSeconds: number | null;
}

export interface RelayV2IssuerVerifyOnlyKey {
  kid: string;
  secretBase64url: string;
  createdAtSeconds: number;
  verifyUntilSeconds: number;
}

export interface RelayV2IssuerKeyring {
  version: typeof RELAY_V2_ISSUER_KEYRING_VERSION;
  issuerId: string;
  activeKey: RelayV2IssuerActiveKey;
  verifyOnlyKeys: RelayV2IssuerVerifyOnlyKey[];
  retiredKids: string[];
}

export type RelayV2AccessTokenPreparation = {
  role: RelayV2AccessRole;
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId?: string;
  nowSeconds: number;
  notBeforeSeconds?: number;
  ttlSeconds?: number;
  jti?: string;
};

export type RelayV2PreparedAccessTokenIssuance = {
  token: string;
  claims: RelayV2AccessTokenClaims;
  nextKeyring: RelayV2IssuerKeyring;
};

export class RelayV2IssuerStateError extends Error {
  readonly code = "AUTH_STATE_INVALID" as const;

  constructor(message = "Relay v2 issuer state is invalid") {
    super(message);
    this.name = "RelayV2IssuerStateError";
  }
}

function stateError(message?: string): never {
  throw new RelayV2IssuerStateError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function decodeStoredSecret(value: unknown): Buffer {
  if (typeof value !== "string") stateError();
  let decoded: Buffer;
  try {
    decoded = decodeCanonicalRelayV2Base64Url(value, MAX_SECRET_BYTES);
  } catch {
    return stateError();
  }
  if (decoded.byteLength < MIN_SECRET_BYTES || decoded.byteLength > MAX_SECRET_BYTES) stateError();
  return decoded;
}

function isActiveKey(value: unknown): value is RelayV2IssuerActiveKey {
  if (!isRecord(value) || !exactKeys(
    value,
    ["kid", "secretBase64url", "createdAtSeconds", "maxIssuedExpSeconds"],
  )) return false;
  if (!isRelayV2AuthIdentifier(value.kid) || !isTimestamp(value.createdAtSeconds)) return false;
  if (
    value.maxIssuedExpSeconds !== null
    && (!isTimestamp(value.maxIssuedExpSeconds) || value.maxIssuedExpSeconds < value.createdAtSeconds)
  ) return false;
  try {
    decodeStoredSecret(value.secretBase64url);
    return true;
  } catch {
    return false;
  }
}

function isVerifyOnlyKey(value: unknown): value is RelayV2IssuerVerifyOnlyKey {
  if (!isRecord(value) || !exactKeys(
    value,
    ["kid", "secretBase64url", "createdAtSeconds", "verifyUntilSeconds"],
  )) return false;
  if (
    !isRelayV2AuthIdentifier(value.kid)
    || !isTimestamp(value.createdAtSeconds)
    || !isTimestamp(value.verifyUntilSeconds)
    || value.verifyUntilSeconds < value.createdAtSeconds
  ) return false;
  try {
    decodeStoredSecret(value.secretBase64url);
    return true;
  } catch {
    return false;
  }
}

export function parseRelayV2IssuerKeyring(value: unknown): RelayV2IssuerKeyring {
  if (!isRecord(value) || !exactKeys(
    value,
    ["version", "issuerId", "activeKey", "verifyOnlyKeys", "retiredKids"],
  )) stateError();
  if (
    value.version !== RELAY_V2_ISSUER_KEYRING_VERSION
    || !isRelayV2AuthIdentifier(value.issuerId)
    || !isActiveKey(value.activeKey)
    || !Array.isArray(value.verifyOnlyKeys)
    || value.verifyOnlyKeys.some((key) => !isVerifyOnlyKey(key))
    || !Array.isArray(value.retiredKids)
    || value.retiredKids.some((kid) => !isRelayV2AuthIdentifier(kid))
  ) stateError();

  const currentKids = [
    (value.activeKey as RelayV2IssuerActiveKey).kid,
    ...(value.verifyOnlyKeys as RelayV2IssuerVerifyOnlyKey[]).map((key) => key.kid),
  ];
  const retiredKids = value.retiredKids as string[];
  const allKids = [...currentKids, ...retiredKids];
  if (new Set(currentKids).size !== currentKids.length) stateError();
  if (new Set(retiredKids).size !== retiredKids.length) stateError();
  if (new Set(allKids).size !== allKids.length) stateError();
  return value as unknown as RelayV2IssuerKeyring;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function newSecret(): string {
  return randomBytes(MIN_SECRET_BYTES).toString("base64url");
}

function validateNewSecret(secretBase64url: string | undefined): string {
  const secret = secretBase64url ?? newSecret();
  decodeStoredSecret(secret);
  return secret;
}

export function createRelayV2IssuerKeyring(options: {
  issuerId: string;
  kid: string;
  secretBase64url?: string;
  nowSeconds?: number;
}): RelayV2IssuerKeyring {
  if (!isRecord(options) || !exactKeys(
    options,
    ["issuerId", "kid"],
    ["secretBase64url", "nowSeconds"],
  )) stateError();
  const createdAtSeconds = options.nowSeconds ?? nowSeconds();
  if (
    !isRelayV2AuthIdentifier(options.issuerId)
    || !isRelayV2AuthIdentifier(options.kid)
    || !isTimestamp(createdAtSeconds)
  ) stateError();
  return parseRelayV2IssuerKeyring({
    version: RELAY_V2_ISSUER_KEYRING_VERSION,
    issuerId: options.issuerId,
    activeKey: {
      kid: options.kid,
      secretBase64url: validateNewSecret(options.secretBase64url),
      createdAtSeconds,
      maxIssuedExpSeconds: null,
    },
    verifyOnlyKeys: [],
    retiredKids: [],
  });
}

function validatePreparation(value: RelayV2AccessTokenPreparation): void {
  if (!isRecord(value) || !exactKeys(
    value,
    ["role", "hostId", "principalId", "grantId", "nowSeconds"],
    ["clientInstanceId", "notBeforeSeconds", "ttlSeconds", "jti"],
  )) stateError();
  if (value.role !== "client" && value.role !== "host") stateError();
  for (const id of [value.hostId, value.principalId, value.grantId]) {
    if (!isRelayV2AuthIdentifier(id)) stateError();
  }
  if (value.role === "client") {
    if (!isRelayV2AuthIdentifier(value.clientInstanceId)) stateError();
  } else if (value.clientInstanceId !== undefined) {
    stateError();
  }
  if (!isTimestamp(value.nowSeconds)) stateError();
  if (value.notBeforeSeconds !== undefined && !isTimestamp(value.notBeforeSeconds)) stateError();
  if (
    value.ttlSeconds !== undefined
    && (!Number.isSafeInteger(value.ttlSeconds)
      || value.ttlSeconds <= 0
      || value.ttlSeconds > RELAY_V2_MAX_ACCESS_TTL_SECONDS)
  ) stateError();
  if (value.jti !== undefined && !isRelayV2AuthIdentifier(value.jti)) stateError();
}

/**
 * Build a pure, uncommitted issuance transition using the active key.
 *
 * This function neither serializes concurrent transitions nor persists state.
 * A future production transaction owner MUST exclusively commit nextKeyring
 * before exposing token. If that commit fails, it MUST discard this entire
 * prepared result so maxIssuedExpSeconds cannot fall behind an exposed token.
 */
export function prepareRelayV2AccessTokenIssuance(
  keyringValue: RelayV2IssuerKeyring,
  preparation: RelayV2AccessTokenPreparation,
): RelayV2PreparedAccessTokenIssuance {
  const keyring = parseRelayV2IssuerKeyring(keyringValue);
  validatePreparation(preparation);
  if (preparation.nowSeconds < keyring.activeKey.createdAtSeconds) stateError();
  const ttlSeconds = preparation.ttlSeconds ?? RELAY_V2_MAX_ACCESS_TTL_SECONDS;
  const notBeforeSeconds = preparation.notBeforeSeconds ?? preparation.nowSeconds;
  const exp = preparation.nowSeconds + ttlSeconds;
  if (!Number.isSafeInteger(exp) || notBeforeSeconds < preparation.nowSeconds || notBeforeSeconds >= exp) {
    stateError();
  }
  const claims: RelayV2AccessTokenClaims = {
    v: 2,
    iss: keyring.issuerId,
    aud: RELAY_V2_ACCESS_TOKEN_AUDIENCE,
    kid: keyring.activeKey.kid,
    tokenUse: "access",
    role: preparation.role,
    hostId: preparation.hostId,
    principalId: preparation.principalId,
    grantId: preparation.grantId,
    ...(preparation.role === "client" ? { clientInstanceId: preparation.clientInstanceId } : {}),
    iat: preparation.nowSeconds,
    nbf: notBeforeSeconds,
    exp,
    jti: preparation.jti ?? randomUUID(),
  };
  const token = encodeRelayV2AccessToken(
    claims,
    decodeStoredSecret(keyring.activeKey.secretBase64url),
  );
  const nextKeyring = parseRelayV2IssuerKeyring({
    ...keyring,
    activeKey: {
      ...keyring.activeKey,
      maxIssuedExpSeconds: Math.max(keyring.activeKey.maxIssuedExpSeconds ?? 0, exp),
    },
  });
  return { token, claims, nextKeyring };
}

export function verifyRelayV2IssuerAccessToken(
  token: string,
  keyringValue: RelayV2IssuerKeyring,
  options: { nowSeconds: number; clockSkewSeconds?: number },
): RelayV2AccessTokenClaims {
  const keyring = parseRelayV2IssuerKeyring(keyringValue);
  return verifyRelayV2AccessToken(token, {
    expectedIssuer: keyring.issuerId,
    nowSeconds: options.nowSeconds,
    clockSkewSeconds: options.clockSkewSeconds,
    resolveSecret: (kid) => {
      if (keyring.activeKey.kid === kid) {
        return decodeStoredSecret(keyring.activeKey.secretBase64url);
      }
      const key = keyring.verifyOnlyKeys.find((candidate) => candidate.kid === kid);
      return key ? decodeStoredSecret(key.secretBase64url) : undefined;
    },
  });
}

export function rotateRelayV2IssuerKeyring(
  keyringValue: RelayV2IssuerKeyring,
  options: {
    kid: string;
    secretBase64url?: string;
    nowSeconds?: number;
  },
): RelayV2IssuerKeyring {
  const keyring = parseRelayV2IssuerKeyring(keyringValue);
  if (!isRecord(options) || !exactKeys(
    options,
    ["kid"],
    ["secretBase64url", "nowSeconds"],
  )) stateError();
  const rotatedAtSeconds = options.nowSeconds ?? nowSeconds();
  if (!isRelayV2AuthIdentifier(options.kid) || !isTimestamp(rotatedAtSeconds)) stateError();
  if (rotatedAtSeconds < keyring.activeKey.createdAtSeconds) stateError();
  const allKids = new Set([
    keyring.activeKey.kid,
    ...keyring.verifyOnlyKeys.map((key) => key.kid),
    ...keyring.retiredKids,
  ]);
  if (allKids.has(options.kid)) stateError("Relay v2 issuer kid cannot be reused");
  const verifyUntilSeconds = Math.max(
    rotatedAtSeconds,
    (keyring.activeKey.maxIssuedExpSeconds ?? rotatedAtSeconds)
      + RELAY_V2_MAX_CLOCK_SKEW_SECONDS,
  );
  return parseRelayV2IssuerKeyring({
    ...keyring,
    activeKey: {
      kid: options.kid,
      secretBase64url: validateNewSecret(options.secretBase64url),
      createdAtSeconds: rotatedAtSeconds,
      maxIssuedExpSeconds: null,
    },
    verifyOnlyKeys: [
      ...keyring.verifyOnlyKeys,
      {
        kid: keyring.activeKey.kid,
        secretBase64url: keyring.activeKey.secretBase64url,
        createdAtSeconds: keyring.activeKey.createdAtSeconds,
        verifyUntilSeconds,
      },
    ],
  });
}

export function removeRelayV2VerifyOnlyKey(
  keyringValue: RelayV2IssuerKeyring,
  kid: string,
  options: { nowSeconds: number; emergency?: boolean },
): RelayV2IssuerKeyring {
  const keyring = parseRelayV2IssuerKeyring(keyringValue);
  if (!isRelayV2AuthIdentifier(kid) || !isRecord(options) || !exactKeys(
    options,
    ["nowSeconds"],
    ["emergency"],
  )) stateError();
  if (!isTimestamp(options.nowSeconds) || (options.emergency !== undefined && typeof options.emergency !== "boolean")) {
    stateError();
  }
  const key = keyring.verifyOnlyKeys.find((candidate) => candidate.kid === kid);
  if (!key) stateError("Relay v2 verify-only key does not exist");
  if (!options.emergency && options.nowSeconds < key.verifyUntilSeconds) {
    stateError("Relay v2 verify-only key is still required");
  }
  return parseRelayV2IssuerKeyring({
    ...keyring,
    verifyOnlyKeys: keyring.verifyOnlyKeys.filter((candidate) => candidate.kid !== kid),
    retiredKids: [...keyring.retiredKids, kid],
  });
}

export function relayV2IssuerKeyringPath(home = homedir()): string {
  return join(home, ".tmux-worktree", "relay-v2-issuer-keyring.json");
}

function validatePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    stateError("Relay v2 issuer state directory is unsafe");
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

function validatePrivateFile(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (uid !== undefined && stat.uid !== uid)
    || (stat.mode & 0o777) !== 0o600
  ) {
    stateError("Relay v2 issuer state file is unsafe");
  }
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

/**
 * Atomically replaces one prepared keyring file. This filesystem seam does not
 * serialize a read-modify-write transition and is not a durable issuance owner.
 */
export function saveRelayV2IssuerKeyring(
  keyringValue: RelayV2IssuerKeyring,
  path = relayV2IssuerKeyringPath(),
): void {
  const keyring = parseRelayV2IssuerKeyring(keyringValue);
  const directory = dirname(path);
  validatePrivateDirectory(directory);
  if (existsSync(path)) {
    const current = loadRelayV2IssuerKeyring(path);
    if (current.issuerId !== keyring.issuerId) stateError();
  }
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fd = -1;
  try {
    fd = openSync(temporary, "wx", 0o600);
    const contents = Buffer.from(`${JSON.stringify(keyring, null, 2)}\n`, "utf8");
    let offset = 0;
    while (offset < contents.byteLength) {
      offset += writeSync(fd, contents, offset, contents.byteLength - offset, offset);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncDirectory(directory);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch {}
    }
    rmSync(temporary, { force: true });
  }
}

export function loadRelayV2IssuerKeyring(
  path = relayV2IssuerKeyringPath(),
): RelayV2IssuerKeyring {
  try {
    validatePrivateFile(path);
    const contents = readFileSync(path);
    if (contents.byteLength > MAX_KEYRING_BYTES) stateError();
    const value = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(contents), {
      maxDepth: 5,
      maxKeys: 4_096,
      maxNodes: 8_192,
    });
    return parseRelayV2IssuerKeyring(value);
  } catch (error) {
    if (error instanceof RelayV2IssuerStateError) throw error;
    throw new RelayV2IssuerStateError();
  }
}
