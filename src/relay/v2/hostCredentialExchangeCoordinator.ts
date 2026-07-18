import type {
  RelayV2HostBootstrapPreparation,
  RelayV2HostBootstrapResponse,
  RelayV2HostCredentialAttemptFence,
  RelayV2HostCredentialResponseCommit,
  RelayV2HostPreparedBootstrap,
  RelayV2HostPreparedRefresh,
  RelayV2HostRefreshPreparation,
  RelayV2HostRefreshResponse,
} from "./hostCredentialAuthority.js";
import type {
  RelayV2HostBootstrapHttpsRequest,
  RelayV2HostBootstrapHttpsResponse,
  RelayV2HostRefreshHttpsRequest,
  RelayV2HostRefreshHttpsResponse,
} from "./hostCredentialHttpsAdapter.js";

export interface RelayV2HostCredentialExchangeAuthority {
  prepareBootstrap(input: RelayV2HostBootstrapPreparation): RelayV2HostPreparedBootstrap;
  applyBootstrapResponse(
    fence: RelayV2HostCredentialAttemptFence,
    response: RelayV2HostBootstrapResponse,
  ): RelayV2HostCredentialResponseCommit;
  prepareRefresh(input: RelayV2HostRefreshPreparation): RelayV2HostPreparedRefresh;
  applyRefreshResponse(
    fence: RelayV2HostCredentialAttemptFence,
    response: RelayV2HostRefreshResponse,
  ): RelayV2HostCredentialResponseCommit;
}

export interface RelayV2HostCredentialExchangeHttpsAdapter {
  bootstrap(
    input: RelayV2HostBootstrapHttpsRequest,
    signal: AbortSignal,
  ): Promise<RelayV2HostBootstrapHttpsResponse>;
  refresh(
    input: RelayV2HostRefreshHttpsRequest,
    signal: AbortSignal,
  ): Promise<RelayV2HostRefreshHttpsResponse>;
}

export interface RelayV2HostCredentialBootstrapExchangeInput
extends RelayV2HostBootstrapPreparation {
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
}

export interface RelayV2HostCredentialRefreshExchangeInput
extends RelayV2HostRefreshPreparation {
  readonly hostInstanceId: string;
}

export interface RelayV2HostCredentialExchangeCoordinatorOptions {
  readonly authority: RelayV2HostCredentialExchangeAuthority;
  readonly httpsAdapter: RelayV2HostCredentialExchangeHttpsAdapter;
}

/**
 * Unwired, default-off orchestration seam for one host credential exchange.
 * Attempt ownership and response fencing remain entirely in the authority;
 * each explicit call performs at most one HTTPS exchange and one exact apply.
 */
export class RelayV2HostCredentialExchangeCoordinator {
  private readonly authority: RelayV2HostCredentialExchangeAuthority;
  private readonly httpsAdapter: RelayV2HostCredentialExchangeHttpsAdapter;

  constructor(options: RelayV2HostCredentialExchangeCoordinatorOptions) {
    this.authority = options.authority;
    this.httpsAdapter = options.httpsAdapter;
  }

  async bootstrap(
    input: RelayV2HostCredentialBootstrapExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
    const prepared = this.authority.prepareBootstrap({
      credentialReference: input.credentialReference,
      hostId: input.hostId,
      attemptId: input.attemptId,
      oldSecretReference: input.oldSecretReference,
    });
    const fence = prepared.fence;
    const credential = prepared.credential;
    const bootstrapAttemptId = fence.attemptId;
    const bootstrapToken = credential.bootstrapToken;
    const hostId = credential.hostId;
    const hostEpoch = input.hostEpoch;
    const hostInstanceId = input.hostInstanceId;
    const response = await this.httpsAdapter.bootstrap({
      bootstrapAttemptId,
      bootstrapToken,
      hostId,
      hostEpoch,
      hostInstanceId,
    }, signal);
    return this.authority.applyBootstrapResponse(fence, response);
  }

  async refresh(
    input: RelayV2HostCredentialRefreshExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
    const prepared = this.authority.prepareRefresh({
      credentialReference: input.credentialReference,
      attemptId: input.attemptId,
      oldSecretReference: input.oldSecretReference,
    });
    const fence = prepared.fence;
    const credential = prepared.credential;
    const refreshAttemptId = fence.attemptId;
    const grantId = credential.grantId;
    const hostInstanceId = input.hostInstanceId;
    const refreshToken = credential.refreshToken;
    const response = await this.httpsAdapter.refresh({
      refreshAttemptId,
      grantId,
      hostInstanceId,
      refreshToken,
    }, signal);
    return this.authority.applyRefreshResponse(fence, response);
  }
}
