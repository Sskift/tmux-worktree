import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";

const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_KEYS = Object.keys;
const REFLECT_APPLY = Reflect.apply;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const BUFFER_FROM = BUFFER_CONSTRUCTOR.from;
const BUFFER_TO_STRING = BUFFER_CONSTRUCTOR.prototype.toString;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_SPLIT = String.prototype.split;
const STRING_TRIM = String.prototype.trim;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;

export const RELAY_V2_ACCESS_TOKEN_PREFIX = "twcap2";
export const RELAY_V2_ACCESS_TOKEN_AUDIENCE = "tw-relay-ws";
export const RELAY_V2_MAX_ACCESS_TTL_SECONDS = 3_600;
export const RELAY_V2_MAX_CLOCK_SKEW_SECONDS = 60;

const MAX_TOKEN_BYTES = 8_192;
const MAX_PAYLOAD_BYTES = 4_096;
const MAC_BYTES = 32;
const MAX_TIMESTAMP_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
const REQUIRED_CLAIM_KEYS = [
  "v",
  "iss",
  "aud",
  "kid",
  "tokenUse",
  "role",
  "hostId",
  "principalId",
  "grantId",
  "iat",
  "nbf",
  "exp",
  "jti",
] as const;
const OPTIONAL_CLAIM_KEYS = ["clientInstanceId"] as const;

export type RelayV2AccessRole = "client" | "host";

export interface RelayV2AccessTokenClaims {
  v: 2;
  iss: string;
  aud: string;
  kid: string;
  tokenUse: "access";
  role: RelayV2AccessRole;
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId?: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export class RelayV2AccessTokenError extends Error {
  readonly code = "AUTH_INVALID" as const;

  constructor() {
    super("Relay v2 access credential is invalid");
    this.name = "RelayV2AccessTokenError";
  }
}

export type RelayV2AccessTokenVerification = {
  expectedIssuer: string;
  expectedAudience?: string;
  nowSeconds: number;
  clockSkewSeconds?: number;
  resolveSecret: (kid: string) => Uint8Array | undefined;
};

function invalid(): never {
  throw new RelayV2AccessTokenError();
}

function typedArrayByteLength(value: Uint8Array): number {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") return invalid();
  try {
    return REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
  } catch {
    return invalid();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = REFLECT_APPLY(
        STRING_CHAR_CODE_AT,
        value,
        [index + 1],
      ) as number;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function isRelayV2AuthIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && BUFFER_BYTE_LENGTH(value, "utf8") <= 128
    && REFLECT_APPLY(STRING_TRIM, value, []) === value
    && !REFLECT_APPLY(REGEXP_TEST, /[\0\r\n]/, [value])
    && !hasUnpairedSurrogate(value);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= MAX_TIMESTAMP_SECONDS;
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set<string>([...REQUIRED_CLAIM_KEYS, ...OPTIONAL_CLAIM_KEYS]);
  return REQUIRED_CLAIM_KEYS.every((key) => OBJECT_HAS_OWN(value, key))
    && OBJECT_KEYS(value).every((key) => allowed.has(key));
}

function validateClaimSemantics(claims: RelayV2AccessTokenClaims): void {
  if (claims.v !== 2 || claims.tokenUse !== "access") invalid();
  if (claims.role !== "client" && claims.role !== "host") invalid();
  for (const value of [
    claims.iss,
    claims.aud,
    claims.kid,
    claims.hostId,
    claims.principalId,
    claims.grantId,
    claims.jti,
  ]) {
    if (!isRelayV2AuthIdentifier(value)) invalid();
  }
  if (claims.role === "client") {
    if (!isRelayV2AuthIdentifier(claims.clientInstanceId)) invalid();
  } else if (claims.clientInstanceId !== undefined) {
    invalid();
  }
  if (!isTimestamp(claims.iat) || !isTimestamp(claims.nbf) || !isTimestamp(claims.exp)) {
    invalid();
  }
  if (claims.iat >= claims.exp || claims.nbf >= claims.exp) invalid();
  if (claims.exp - claims.iat > RELAY_V2_MAX_ACCESS_TTL_SECONDS) invalid();
}

function parseClaims(payload: Uint8Array): RelayV2AccessTokenClaims {
  const value = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(payload), {
    maxDepth: 2,
    maxKeys: 14,
    maxNodes: 15,
  });
  if (!isRecord(value) || !hasExactKeys(value)) invalid();
  const claims = value as unknown as RelayV2AccessTokenClaims;
  validateClaimSemantics(claims);
  return claims;
}

export function decodeCanonicalRelayV2Base64Url(
  value: string,
  maxDecodedBytes: number,
): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 === 1
    || !REFLECT_APPLY(REGEXP_TEST, /^[A-Za-z0-9_-]+$/, [value])
    || Math.floor(value.length * 3 / 4) > maxDecodedBytes
  ) {
    invalid();
  }
  const decoded = REFLECT_APPLY(
    BUFFER_FROM,
    BUFFER_CONSTRUCTOR,
    [value, "base64url"],
  ) as Buffer;
  if (typedArrayByteLength(decoded) > maxDecodedBytes
    || REFLECT_APPLY(BUFFER_TO_STRING, decoded, ["base64url"]) !== value) invalid();
  return decoded;
}

function validateSecret(secret: Uint8Array): Buffer {
  if (!(secret instanceof Uint8Array)
    || typedArrayByteLength(secret) < 32
    || typedArrayByteLength(secret) > 64) {
    invalid();
  }
  return REFLECT_APPLY(
    BUFFER_FROM,
    BUFFER_CONSTRUCTOR,
    [secret],
  ) as Buffer;
}

function canonicalClaimsObject(claims: RelayV2AccessTokenClaims): Record<string, unknown> {
  const result: Record<string, unknown> = {
    v: claims.v,
    iss: claims.iss,
    aud: claims.aud,
    kid: claims.kid,
    tokenUse: claims.tokenUse,
    role: claims.role,
    hostId: claims.hostId,
    principalId: claims.principalId,
    grantId: claims.grantId,
  };
  if (claims.role === "client") result.clientInstanceId = claims.clientInstanceId;
  result.iat = claims.iat;
  result.nbf = claims.nbf;
  result.exp = claims.exp;
  result.jti = claims.jti;
  return result;
}

export function encodeRelayV2AccessToken(
  claims: RelayV2AccessTokenClaims,
  secret: Uint8Array,
): string {
  try {
    if (!isRecord(claims) || !hasExactKeys(claims)) invalid();
    validateClaimSemantics(claims);
    const key = validateSecret(secret);
    const payloadBytes = REFLECT_APPLY(
      BUFFER_FROM,
      BUFFER_CONSTRUCTOR,
      [JSON.stringify(canonicalClaimsObject(claims)), "utf8"],
    ) as Buffer;
    const payload = REFLECT_APPLY(
      BUFFER_TO_STRING,
      payloadBytes,
      ["base64url"],
    ) as string;
    const mac = createHmac("sha256", key)
      .update(`${RELAY_V2_ACCESS_TOKEN_PREFIX}.${payload}`, "ascii")
      .digest("base64url");
    return `${RELAY_V2_ACCESS_TOKEN_PREFIX}.${payload}.${mac}`;
  } catch {
    return invalid();
  }
}

export function verifyRelayV2AccessToken(
  token: string,
  options: RelayV2AccessTokenVerification,
): RelayV2AccessTokenClaims {
  try {
    if (
      typeof token !== "string"
      || token.length === 0
      || BUFFER_BYTE_LENGTH(token, "utf8") > MAX_TOKEN_BYTES
      || REFLECT_APPLY(REGEXP_TEST, /\s/, [token])
    ) {
      invalid();
    }
    const segments = REFLECT_APPLY(STRING_SPLIT, token, ["."]) as string[];
    if (segments.length !== 3 || segments[0] !== RELAY_V2_ACCESS_TOKEN_PREFIX) invalid();
    const payloadSegment = segments[1];
    const macSegment = segments[2];
    const payload = decodeCanonicalRelayV2Base64Url(payloadSegment, MAX_PAYLOAD_BYTES);
    const mac = decodeCanonicalRelayV2Base64Url(macSegment, MAC_BYTES);
    if (typedArrayByteLength(mac) !== MAC_BYTES) invalid();

    const claims = parseClaims(payload);
    const secret = options.resolveSecret(claims.kid);
    if (!secret) invalid();
    const expectedMac = createHmac("sha256", validateSecret(secret))
      .update(`${RELAY_V2_ACCESS_TOKEN_PREFIX}.${payloadSegment}`, "ascii")
      .digest();
    if (!timingSafeEqual(expectedMac, mac)) invalid();

    const audience = options.expectedAudience ?? RELAY_V2_ACCESS_TOKEN_AUDIENCE;
    if (claims.iss !== options.expectedIssuer || claims.aud !== audience) invalid();
    const skew = options.clockSkewSeconds ?? RELAY_V2_MAX_CLOCK_SKEW_SECONDS;
    if (
      !isTimestamp(options.nowSeconds)
      || !Number.isSafeInteger(skew)
      || skew < 0
      || skew > RELAY_V2_MAX_CLOCK_SKEW_SECONDS
    ) {
      invalid();
    }
    if (options.nowSeconds < claims.iat - skew || options.nowSeconds < claims.nbf - skew) {
      invalid();
    }
    if (options.nowSeconds >= claims.exp + skew) invalid();
    return claims;
  } catch {
    return invalid();
  }
}
