import type {
  RelayV2HostBootstrapPreparation,
  RelayV2HostBootstrapResponse,
  RelayV2HostCredentialCapturedExchangeCut,
  RelayV2HostCredentialAttemptFence,
  RelayV2HostCredentialExchangeCut,
  RelayV2HostCredentialExchangeCutInput,
  RelayV2HostCredentialInspection,
  RelayV2HostCredentialResponseCommit,
  RelayV2HostPreparedBootstrap,
  RelayV2HostPreparedBootstrapFromCut,
  RelayV2HostPreparedRefresh,
  RelayV2HostPreparedRefreshFromCut,
  RelayV2HostRefreshPreparation,
  RelayV2HostRefreshResponse,
} from "./hostCredentialAuthority.js";
import {
  isRelayV2HostCredentialAuthority,
  RelayV2HostCredentialAuthority,
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

export interface RelayV2HostCredentialOwnerBoundExchangePort {
  inspect(reference: string): RelayV2HostCredentialInspection | null;
  capture(input: RelayV2HostCredentialExchangeCutInput): RelayV2HostCredentialCapturedExchangeCut;
  release(cut: RelayV2HostCredentialExchangeCut): void;
  bootstrap(
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostCredentialBootstrapExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit>;
  refresh(
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostCredentialRefreshExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit>;
}

const ownerBoundExchangePorts = new WeakSet<object>();
const hostCredentialExchangeCoordinatorAuthorities = new WeakMap<
object,
RelayV2HostCredentialAuthority
>();

export function isRelayV2HostCredentialOwnerBoundExchangePort(
  value: unknown,
): value is RelayV2HostCredentialOwnerBoundExchangePort {
  return typeof value === "object"
    && value !== null
    && ownerBoundExchangePorts.has(value);
}

export function isRelayV2HostCredentialExchangeCoordinatorForAuthority(
  value: unknown,
  authority: RelayV2HostCredentialAuthority,
): value is RelayV2HostCredentialExchangeCoordinator {
  return typeof value === "object"
    && value !== null
    && isRelayV2HostCredentialAuthority(authority)
    && hostCredentialExchangeCoordinatorAuthorities.get(value) === authority;
}

export class RelayV2HostCredentialOwnerBindingError extends Error {
  constructor() {
    super("Relay v2 host credential exchange owner binding is unavailable");
    this.name = "RelayV2HostCredentialOwnerBindingError";
  }
}

/**
 * Unwired, default-off orchestration seam for one host credential exchange.
 * Attempt ownership and response fencing remain entirely in the authority;
 * each explicit call performs at most one HTTPS exchange and one exact apply.
 */
export class RelayV2HostCredentialExchangeCoordinator {
  private readonly authority: RelayV2HostCredentialExchangeAuthority;
  private readonly httpsAdapter: RelayV2HostCredentialExchangeHttpsAdapter;
  private ownerBoundPort: RelayV2HostCredentialOwnerBoundExchangePort | null = null;

  constructor(options: RelayV2HostCredentialExchangeCoordinatorOptions) {
    this.authority = options.authority;
    this.httpsAdapter = options.httpsAdapter;
    if (isRelayV2HostCredentialAuthority(options.authority)) {
      hostCredentialExchangeCoordinatorAuthorities.set(this, options.authority);
    }
  }

  createOwnerBoundPort(): RelayV2HostCredentialOwnerBoundExchangePort {
    if (this.ownerBoundPort !== null) return this.ownerBoundPort;
    if (!isRelayV2HostCredentialAuthority(this.authority)) {
      throw new RelayV2HostCredentialOwnerBindingError();
    }
    const authority: RelayV2HostCredentialAuthority = this.authority;
    const port = Object.freeze({
      inspect: (reference: string) => authority.inspect(reference),
      capture: (input: RelayV2HostCredentialExchangeCutInput) => (
        authority.captureExchangeCut(input)
      ),
      release: (cut: RelayV2HostCredentialExchangeCut) => {
        authority.releaseIssuedExchangeCut(cut);
      },
      bootstrap: (
        cut: RelayV2HostCredentialExchangeCut,
        input: RelayV2HostCredentialBootstrapExchangeInput,
        signal: AbortSignal,
      ) => this.bootstrapFromCut(authority, cut, input, signal),
      refresh: (
        cut: RelayV2HostCredentialExchangeCut,
        input: RelayV2HostCredentialRefreshExchangeInput,
        signal: AbortSignal,
      ) => this.refreshFromCut(authority, cut, input, signal),
    });
    ownerBoundExchangePorts.add(port);
    this.ownerBoundPort = port;
    return port;
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
    return this.exchangeBootstrap(prepared, input, signal);
  }

  private async bootstrapFromCut(
    authority: RelayV2HostCredentialAuthority,
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostCredentialBootstrapExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
    let preparedFromCut: RelayV2HostPreparedBootstrapFromCut | null = null;
    try {
      preparedFromCut = authority.prepareBootstrapFromCut(cut, {
        credentialReference: input.credentialReference,
        hostId: input.hostId,
        attemptId: input.attemptId,
        oldSecretReference: input.oldSecretReference,
      });
      return await this.exchangeBootstrap(preparedFromCut.prepared, input, signal);
    } finally {
      authority.releaseIssuedExchangeCut(cut);
      if (preparedFromCut !== null) {
        authority.releaseExchangeLease(preparedFromCut.lease);
      }
    }
  }

  private async exchangeBootstrap(
    prepared: RelayV2HostPreparedBootstrap,
    input: RelayV2HostCredentialBootstrapExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
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
    return this.exchangeRefresh(prepared, input, signal);
  }

  private async refreshFromCut(
    authority: RelayV2HostCredentialAuthority,
    cut: RelayV2HostCredentialExchangeCut,
    input: RelayV2HostCredentialRefreshExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
    let preparedFromCut: RelayV2HostPreparedRefreshFromCut | null = null;
    try {
      preparedFromCut = authority.prepareRefreshFromCut(cut, {
        credentialReference: input.credentialReference,
        attemptId: input.attemptId,
        oldSecretReference: input.oldSecretReference,
      });
      return await this.exchangeRefresh(preparedFromCut.prepared, input, signal);
    } finally {
      authority.releaseIssuedExchangeCut(cut);
      if (preparedFromCut !== null) {
        authority.releaseExchangeLease(preparedFromCut.lease);
      }
    }
  }

  private async exchangeRefresh(
    prepared: RelayV2HostPreparedRefresh,
    input: RelayV2HostCredentialRefreshExchangeInput,
    signal: AbortSignal,
  ): Promise<RelayV2HostCredentialResponseCommit> {
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
