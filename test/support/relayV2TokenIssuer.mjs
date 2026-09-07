import {
  createRelayV2IssuerKeyring,
  prepareRelayV2AccessTokenIssuance,
} from "../../dist/relay/v2/issuer.js";

/**
 * Factory for the host access-token issuer test doubles used across the
 * Relay v2 host credential tests. The eight local implementations differed
 * only in key id, secret byte, time source, principal/grant defaults, jti
 * prefix, return shape, and whether hostId is fixed or passed per call.
 *
 * Options:
 * - kid, secretByte, baseTime: issuer keyring parameters
 * - hostId: fixed host id for zero-arg issuers; omit for issuers that take
 *   hostId as their first call argument
 * - principalId, grantId: defaults for the issuance request
 * - jtiPrefix: prefix for the monotonic jti
 * - shape: "reshaped" (default) returns { token, jti?, expiresAtMs };
 *   "raw" returns the prepared issuance object
 * - includeJti: when reshaped, whether to include the jti field
 * - overrides: when true, the raw issuer accepts (hostId, overrides) with
 *   per-call principalId/grantId
 */
export function createTokenIssuer({
  kid,
  secretByte,
  baseTime,
  hostId = null,
  principalId,
  grantId,
  jtiPrefix = "host-access-jti-",
  shape = "reshaped",
  includeJti = true,
  overrides = false,
}) {
  let keyring = createRelayV2IssuerKeyring({
    issuerId: "relay-issuer-id",
    kid,
    secretBase64url: Buffer.alloc(32, secretByte).toString("base64url"),
    nowSeconds: baseTime,
  });
  let sequence = 0;
  return (argHostId, callOverrides) => {
    sequence += 1;
    const effectiveHostId = hostId ?? argHostId;
    const effectivePrincipalId = overrides && callOverrides?.principalId !== undefined
      ? callOverrides.principalId
      : principalId;
    const effectiveGrantId = overrides && callOverrides?.grantId !== undefined
      ? callOverrides.grantId
      : grantId;
    const prepared = prepareRelayV2AccessTokenIssuance(keyring, {
      role: "host",
      hostId: effectiveHostId,
      principalId: effectivePrincipalId,
      grantId: effectiveGrantId,
      nowSeconds: baseTime + sequence,
      jti: `${jtiPrefix}${sequence}`,
    });
    keyring = prepared.nextKeyring;
    if (shape === "raw") return prepared;
    const result = { token: prepared.token, expiresAtMs: prepared.claims.exp * 1_000 };
    if (includeJti) result.jti = prepared.claims.jti;
    return result;
  };
}
