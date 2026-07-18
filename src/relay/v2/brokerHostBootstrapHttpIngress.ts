import type {
  RelayV2BrokerCredentialGrantCredential,
  RelayV2BrokerCredentialHttpSourceAdmission,
} from "./brokerCredentialAuthority.js";
import {
  handleRelayV2BrokerCredentialHttpBoundary,
  RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES,
  type RelayV2BrokerCredentialHttpBody,
  type RelayV2BrokerCredentialHttpBoundaryRoute,
  type RelayV2BrokerCredentialHttpHeader,
  type RelayV2BrokerCredentialHttpRequest,
  type RelayV2BrokerCredentialHttpResponse,
  type RelayV2BrokerCredentialHttpSourceAuthorityPort,
  type RelayV2BrokerCredentialHttpStatus,
} from "./brokerCredentialHttpBoundary.js";
import type { RelayV2JsonObject } from "./codecSchema.js";

export const RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH = "/v2/hosts/bootstrap";
export { RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES };

export type RelayV2BrokerHostBootstrapHttpStatus = RelayV2BrokerCredentialHttpStatus;
export type RelayV2BrokerHostBootstrapHttpHeader = RelayV2BrokerCredentialHttpHeader;
export type RelayV2BrokerHostBootstrapHttpBody = RelayV2BrokerCredentialHttpBody;
export type RelayV2BrokerHostBootstrapHttpRequest = RelayV2BrokerCredentialHttpRequest;
export type RelayV2BrokerHostBootstrapHttpResponse = RelayV2BrokerCredentialHttpResponse;

/** The only credential behavior visible to the B1 HTTP boundary. */
export interface RelayV2BrokerHostBootstrapAuthorityPort
extends RelayV2BrokerCredentialHttpSourceAuthorityPort {
  bootstrapHost(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: RelayV2BrokerHostBootstrapInput,
  ): Promise<RelayV2BrokerCredentialGrantCredential>;
}

export interface RelayV2BrokerHostBootstrapInput {
  bootstrapAttemptId: string;
  bootstrapToken: string;
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
}

function bootstrapInput(body: RelayV2JsonObject): RelayV2BrokerHostBootstrapInput {
  return {
    bootstrapAttemptId: body.bootstrapAttemptId as string,
    bootstrapToken: body.bootstrapToken as string,
    hostId: body.hostId as string,
    hostEpoch: body.hostEpoch as string,
    hostInstanceId: body.hostInstanceId as string,
  };
}

const ROUTES: readonly RelayV2BrokerCredentialHttpBoundaryRoute<
  RelayV2BrokerHostBootstrapAuthorityPort
>[] = Object.freeze([Object.freeze({
  path: RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH,
  sourceEndpoint: "host_bootstrap",
  requestSchema: "host.bootstrap.request",
  responseSchema: "host.bootstrap.response",
  async invoke(authority, admission, sourceKey, body) {
    const result = await authority.bootstrapHost(
      admission,
      sourceKey,
      bootstrapInput(body),
    );
    if (result.endpoint !== "host_bootstrap") {
      throw new Error("Relay v2 host bootstrap authority returned an invalid response");
    }
    return result.body as unknown as RelayV2JsonObject;
  },
})]);

/**
 * Strict, unwired POST /v2/hosts/bootstrap ingress foundation.
 *
 * `sourceKey` is a separate trusted-composition input and is never derived
 * from the URL, body, Forwarded, X-Forwarded-For, or another request header.
 */
export function handleRelayV2BrokerHostBootstrapHttpIngress(
  authority: RelayV2BrokerHostBootstrapAuthorityPort,
  sourceKey: string,
  request: RelayV2BrokerHostBootstrapHttpRequest,
): Promise<RelayV2BrokerHostBootstrapHttpResponse> {
  return handleRelayV2BrokerCredentialHttpBoundary(
    authority,
    sourceKey,
    request,
    ROUTES,
  );
}
