import {
  parseRelayV2IssuerKeyring,
  verifyRelayV2IssuerAccessToken,
  type RelayV2IssuerKeyring,
} from "./issuer.js";
import {
  isRelayV2AuthIdentifier,
  type RelayV2AccessRole,
  type RelayV2AccessTokenClaims,
} from "./token.js";

export interface RelayV2GrantBinding {
  role: RelayV2AccessRole;
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId: string | null;
  revokedAtSeconds: number | null;
  expiresAtSeconds: number | null;
}

export interface RelayV2AuthContext {
  scheme: "twcap2";
  role: RelayV2AccessRole;
  hostId: string;
  principalId: string;
  grantId: string;
  clientInstanceId: string | null;
  jti: string;
  kid: string;
  expiresAtMs: number;
}

export type RelayV2AccessAuthorization = {
  keyring: RelayV2IssuerKeyring;
  grant: RelayV2GrantBinding | undefined;
  nowSeconds: number;
  clockSkewSeconds?: number;
  expectedRole?: RelayV2AccessRole;
  expectedHostId?: string;
};

export type RelayV2AuthErrorCode =
  | "AUTH_INVALID"
  | "GRANT_NOT_FOUND"
  | "ROLE_MISMATCH"
  | "PERMISSION_DENIED";

export class RelayV2AuthError extends Error {
  constructor(readonly code: RelayV2AuthErrorCode) {
    super(code === "AUTH_INVALID"
      ? "Relay v2 access credential is invalid"
      : "Relay v2 access credential is not authorized");
    this.name = "RelayV2AuthError";
  }
}

function deny(code: RelayV2AuthErrorCode): never {
  throw new RelayV2AuthError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key));
}

function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function validateGrant(grant: RelayV2GrantBinding): void {
  if (!isRecord(grant) || !exactKeys(grant, [
    "role",
    "hostId",
    "principalId",
    "grantId",
    "clientInstanceId",
    "revokedAtSeconds",
    "expiresAtSeconds",
  ])) deny("PERMISSION_DENIED");
  if (grant.role !== "client" && grant.role !== "host") deny("PERMISSION_DENIED");
  for (const id of [grant.hostId, grant.principalId, grant.grantId]) {
    if (!isRelayV2AuthIdentifier(id)) deny("PERMISSION_DENIED");
  }
  if (grant.role === "client") {
    if (!isRelayV2AuthIdentifier(grant.clientInstanceId)) deny("PERMISSION_DENIED");
  } else if (grant.clientInstanceId !== null) {
    deny("PERMISSION_DENIED");
  }
  if (!isTimestampOrNull(grant.revokedAtSeconds) || !isTimestampOrNull(grant.expiresAtSeconds)) {
    deny("PERMISSION_DENIED");
  }
}

function bindClaims(
  claims: RelayV2AccessTokenClaims,
  authorization: RelayV2AccessAuthorization,
): RelayV2AuthContext {
  if (authorization.expectedRole !== undefined && claims.role !== authorization.expectedRole) {
    deny("ROLE_MISMATCH");
  }
  if (authorization.expectedHostId !== undefined) {
    if (!isRelayV2AuthIdentifier(authorization.expectedHostId)) deny("PERMISSION_DENIED");
    if (claims.hostId !== authorization.expectedHostId) deny("PERMISSION_DENIED");
  }
  const grant = authorization.grant;
  if (!grant) deny("GRANT_NOT_FOUND");
  validateGrant(grant);
  if (grant.revokedAtSeconds !== null) deny("PERMISSION_DENIED");
  if (grant.expiresAtSeconds !== null && authorization.nowSeconds >= grant.expiresAtSeconds) {
    deny("PERMISSION_DENIED");
  }
  if (claims.role !== grant.role) deny("ROLE_MISMATCH");
  if (
    claims.hostId !== grant.hostId
    || claims.principalId !== grant.principalId
    || claims.grantId !== grant.grantId
    || (claims.clientInstanceId ?? null) !== grant.clientInstanceId
  ) {
    deny("PERMISSION_DENIED");
  }
  return Object.freeze({
    scheme: "twcap2",
    role: claims.role,
    hostId: claims.hostId,
    principalId: claims.principalId,
    grantId: claims.grantId,
    clientInstanceId: claims.clientInstanceId ?? null,
    jti: claims.jti,
    kid: claims.kid,
    expiresAtMs: claims.exp * 1_000,
  });
}

export function verifyRelayV2AccessAuthorization(
  token: string,
  authorization: RelayV2AccessAuthorization,
): RelayV2AuthContext {
  try {
    const keyring = parseRelayV2IssuerKeyring(authorization.keyring);
    const claims = verifyRelayV2IssuerAccessToken(token, keyring, {
      nowSeconds: authorization.nowSeconds,
      clockSkewSeconds: authorization.clockSkewSeconds,
    });
    return bindClaims(claims, authorization);
  } catch (error) {
    if (error instanceof RelayV2AuthError) throw error;
    deny("AUTH_INVALID");
  }
}
