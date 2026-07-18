import {
  isRelayV2BrokerCredentialAuthorityError,
  RelayV2BrokerCredentialAuthorityError,
  type RelayV2BrokerCredentialGrantCredential,
  type RelayV2BrokerCredentialHttpSourceAdmission,
  type RelayV2BrokerCredentialSelfRevokeResult,
} from "./brokerCredentialAuthority.js";
import type {
  RelayV2BrokerConnectionAuthorization,
} from "./brokerCore.js";
import {
  handleRelayV2BrokerCredentialHttpBoundary,
  requireRelayV2BrokerCredentialBearerAuthorization,
  type RelayV2BrokerCredentialHttpBoundaryRoute,
  type RelayV2BrokerCredentialHttpHeader,
  type RelayV2BrokerCredentialHttpRequest,
  type RelayV2BrokerCredentialHttpResponse,
  type RelayV2BrokerCredentialHttpSourceAuthorityPort,
} from "./brokerCredentialHttpBoundary.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import {
  isRelayV2AuthIdentifier,
  type RelayV2AccessRole,
} from "./token.js";

export const RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH = "/v2/enrollments/redeem";
export const RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH = "/v2/tokens/refresh";
export const RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH = "/v2/hosts/tokens/refresh";
export const RELAY_V2_BROKER_SELF_REVOKE_PATH = "/v2/grants/self/revoke";

export interface RelayV2BrokerCredentialHttpIngressAuthorityPort
extends RelayV2BrokerCredentialHttpSourceAuthorityPort {
  authorizeAccessToken(
    token: string,
    expectedRole: RelayV2AccessRole,
  ): Promise<RelayV2BrokerConnectionAuthorization>;
  redeemEnrollment(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      exchangeAttemptId: string;
      enrollmentId: string;
      enrollmentCode: string;
      clientInstanceId: string;
      deviceLabel: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential>;
  refreshClientGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      refreshAttemptId: string;
      grantId: string;
      clientInstanceId: string;
      refreshToken: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential>;
  refreshHostGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: {
      refreshAttemptId: string;
      grantId: string;
      hostInstanceId: string;
      refreshToken: string;
    },
  ): Promise<RelayV2BrokerCredentialGrantCredential>;
  selfRevokeGrantFromHttp(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    currentAuthContext: Readonly<RelayV2BrokerConnectionAuthorization>,
    input: { reason: "user_revoked" },
  ): Promise<Readonly<RelayV2BrokerCredentialSelfRevokeResult>>;
}

function grantBody(
  result: RelayV2BrokerCredentialGrantCredential,
  endpoint: RelayV2BrokerCredentialGrantCredential["endpoint"],
): RelayV2JsonObject {
  if (result.endpoint !== endpoint) {
    throw new Error("Relay v2 credential authority returned an invalid response");
  }
  return result.body as unknown as RelayV2JsonObject;
}

function clientAuthorization(
  value: unknown,
): Readonly<RelayV2BrokerConnectionAuthorization> {
  const keys = (value !== null && typeof value === "object")
    ? Reflect.ownKeys(value)
    : [];
  if (
    value === null
    || typeof value !== "object"
    || keys.length !== 11
    || ![
      "scheme",
      "role",
      "hostId",
      "principalId",
      "grantId",
      "clientInstanceId",
      "jti",
      "kid",
      "expiresAtMs",
      "authorizationRevision",
      "authorizationFence",
    ].every((key) => Object.hasOwn(value, key))
  ) throw new Error("Relay v2 credential authority returned invalid authentication");
  const candidate = value as RelayV2BrokerConnectionAuthorization;
  if (
    candidate.scheme !== "twcap2"
    || candidate.role !== "client"
    || !isRelayV2AuthIdentifier(candidate.hostId)
    || !isRelayV2AuthIdentifier(candidate.principalId)
    || !isRelayV2AuthIdentifier(candidate.grantId)
    || !isRelayV2AuthIdentifier(candidate.clientInstanceId)
    || !isRelayV2AuthIdentifier(candidate.jti)
    || !isRelayV2AuthIdentifier(candidate.kid)
    || !Number.isSafeInteger(candidate.expiresAtMs)
    || candidate.expiresAtMs < 0
    || typeof candidate.authorizationRevision !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(candidate.authorizationRevision)
    || BigInt(candidate.authorizationRevision) > 18_446_744_073_709_551_615n
    || !isRelayV2AuthIdentifier(candidate.authorizationFence)
  ) throw new Error("Relay v2 credential authority returned invalid authentication");
  return Object.freeze({
    scheme: candidate.scheme,
    role: candidate.role,
    hostId: candidate.hostId,
    principalId: candidate.principalId,
    grantId: candidate.grantId,
    clientInstanceId: candidate.clientInstanceId,
    jti: candidate.jti,
    kid: candidate.kid,
    expiresAtMs: candidate.expiresAtMs,
    authorizationRevision: candidate.authorizationRevision,
    authorizationFence: candidate.authorizationFence,
  });
}

const ROUTES: readonly RelayV2BrokerCredentialHttpBoundaryRoute<
  RelayV2BrokerCredentialHttpIngressAuthorityPort
>[] = Object.freeze([
  Object.freeze({
    path: RELAY_V2_BROKER_ENROLLMENT_REDEEM_PATH,
    sourceEndpoint: "enrollment_redeem",
    requestSchema: "enrollment.redeem.request",
    responseSchema: "enrollment.redeem.response",
    async invoke(authority, admission, sourceKey, body) {
      const result = await authority.redeemEnrollment(admission, sourceKey, {
        exchangeAttemptId: body.exchangeAttemptId as string,
        enrollmentId: body.enrollmentId as string,
        enrollmentCode: body.enrollmentCode as string,
        clientInstanceId: body.clientInstanceId as string,
        deviceLabel: body.deviceLabel as string,
      });
      return grantBody(result, "enrollment_redeem");
    },
  }),
  Object.freeze({
    path: RELAY_V2_BROKER_CLIENT_TOKEN_REFRESH_PATH,
    sourceEndpoint: "client_refresh",
    requestSchema: "token.refresh.client.request",
    responseSchema: "token.refresh.client.response",
    async invoke(authority, admission, sourceKey, body) {
      const result = await authority.refreshClientGrantFromHttp(
        admission,
        sourceKey,
        {
          refreshAttemptId: body.refreshAttemptId as string,
          grantId: body.grantId as string,
          clientInstanceId: body.clientInstanceId as string,
          refreshToken: body.refreshToken as string,
        },
      );
      return grantBody(result, "client_refresh");
    },
  }),
  Object.freeze({
    path: RELAY_V2_BROKER_HOST_TOKEN_REFRESH_PATH,
    sourceEndpoint: "host_refresh",
    requestSchema: "token.refresh.host.request",
    responseSchema: "token.refresh.host.response",
    async invoke(authority, admission, sourceKey, body) {
      const result = await authority.refreshHostGrantFromHttp(
        admission,
        sourceKey,
        {
          refreshAttemptId: body.refreshAttemptId as string,
          grantId: body.grantId as string,
          hostInstanceId: body.hostInstanceId as string,
          refreshToken: body.refreshToken as string,
        },
      );
      return grantBody(result, "host_refresh");
    },
  }),
  Object.freeze({
    path: RELAY_V2_BROKER_SELF_REVOKE_PATH,
    sourceEndpoint: "self_revoke",
    requestSchema: "grant.self-revoke.request",
    responseSchema: "grant.self-revoke.response",
    async authenticate(authority, headers: readonly RelayV2BrokerCredentialHttpHeader[]) {
      const token = requireRelayV2BrokerCredentialBearerAuthorization(headers);
      try {
        return clientAuthorization(
          await authority.authorizeAccessToken(token, "client"),
        );
      } catch (error) {
        if (
          isRelayV2BrokerCredentialAuthorityError(error)
          && ["AUTH_INVALID", "PERMISSION_DENIED", "GRANT_NOT_FOUND"].includes(error.code)
        ) throw new RelayV2BrokerCredentialAuthorityError("AUTH_INVALID");
        throw error;
      }
    },
    async invoke(authority, admission, sourceKey, body, authentication) {
      const result = await authority.selfRevokeGrantFromHttp(
        admission,
        sourceKey,
        authentication as Readonly<RelayV2BrokerConnectionAuthorization>,
        { reason: body.reason as "user_revoked" },
      );
      return {
        grantId: result.grantId,
        revokedAtMs: result.revokedAtMs,
        alreadyRevoked: result.alreadyRevoked,
      };
    },
  }),
]);

/**
 * Strict, unwired ingress foundation for the four frozen B4 credential HTTPS
 * endpoints. `sourceKey` is supplied only by a future trusted server adapter;
 * no listener, router, socket, readiness, or fallback is registered here.
 */
export function handleRelayV2BrokerCredentialHttpIngress(
  authority: RelayV2BrokerCredentialHttpIngressAuthorityPort,
  sourceKey: string,
  request: RelayV2BrokerCredentialHttpRequest,
): Promise<RelayV2BrokerCredentialHttpResponse> {
  return handleRelayV2BrokerCredentialHttpBoundary(
    authority,
    sourceKey,
    request,
    ROUTES,
  );
}
