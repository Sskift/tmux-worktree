import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  DashboardBackend,
  HostConfig,
  HostStatus,
  ProjectPreset,
} from "../../platform";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochLease,
  type OwnerEpochLeaseController,
} from "../ownerEpochLease";
import { useVisibilityAwarePolling } from "./useVisibilityAwarePolling";

const HOST_STATUS_REFRESH_MS = 15_000;
const HOST_STATUS_HIDDEN_REFRESH_MS = 60_000;
const HOST_CATALOG_RETRY_MS = 3_000;
const HOST_CATALOG_HIDDEN_RETRY_MS = 15_000;

type ConnectionCatalogOwnerTag = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

type ConnectionCatalogState = Readonly<{
  owner: ConnectionCatalogOwnerTag | null;
  projectPresets: ProjectPreset[];
  hosts: HostConfig[];
  hostsHydrationGeneration: number;
  catalogReloadRequired: boolean;
  hostsLoadError: string | null;
  sshHostCandidates: HostConfig[];
  hostStatuses: Record<string, HostStatus>;
  installingHostId: string | null;
}>;

type ConnectionRequest = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  token: symbol;
}>;

type HostCatalogRequest = ConnectionRequest & Readonly<{
  revision: number;
}>;

type HostCandidateRequest = ConnectionRequest & Readonly<{
  parent: HostCatalogRequest;
}>;

type HostStatusRequest = ConnectionRequest & Readonly<{
  revision: number;
  sourceKey: string;
}>;

type HostInstallRequest = ConnectionRequest & Readonly<{
  hostId: string;
  hostFingerprint: string;
  previousStatus: HostStatus | null;
}>;

type ConnectionCatalogRegistration = {
  fence: OwnerEpochLeaseController<DashboardBackend>;
  backend: DashboardBackend | null;
  setPublishedState: Dispatch<SetStateAction<ConnectionCatalogState>>;
  projectPresets: ProjectPreset[];
  hosts: HostConfig[];
  hostsHydrationGeneration: number;
  catalogReloadRequired: boolean;
  hostsLoadError: string | null;
  sshHostCandidates: HostConfig[];
  hostStatuses: Record<string, HostStatus>;
  installingHostId: string | null;
  catalogRevision: number;
  hostSourceKey: string;
  observedStatusSourceKey: string | null;
  projectRequest: ConnectionRequest | null;
  hostCatalogRequest: HostCatalogRequest | null;
  candidateRequest: HostCandidateRequest | null;
  statusRequest: HostStatusRequest | null;
  installRequest: HostInstallRequest | null;
};

type ConnectionCatalogOwnerPhaseHandle = Readonly<{
  registration: ConnectionCatalogRegistration;
}>;

type ConnectionCatalogController = Readonly<{
  projectPresets: ProjectPreset[];
  loadProjectPresets(): Promise<void>;
  hosts: HostConfig[];
  hostsHydrationGeneration: number;
  catalogReloadRequired: boolean;
  hostsLoadError: string | null;
  onHostsMutationSettled(hosts: HostConfig[], acceptPayload: boolean): boolean;
  sshHostCandidates: HostConfig[];
  hostStatuses: Record<string, HostStatus>;
  installingHostId: string | null;
  installRemoteTw(hostId: string): Promise<void>;
  ownerEpochKey: string;
  ownerPhase: ConnectionCatalogOwnerPhaseHandle;
}>;

const EMPTY_PROJECT_PRESETS: ProjectPreset[] = [];
const EMPTY_HOSTS: HostConfig[] = [];
const EMPTY_HOST_STATUSES: Record<string, HostStatus> = {};

const EMPTY_STATE: ConnectionCatalogState = {
  owner: null,
  projectPresets: EMPTY_PROJECT_PRESETS,
  hosts: EMPTY_HOSTS,
  hostsHydrationGeneration: 0,
  catalogReloadRequired: false,
  hostsLoadError: null,
  sshHostCandidates: EMPTY_HOSTS,
  hostStatuses: EMPTY_HOST_STATUSES,
  installingHostId: null,
};

function hostFingerprint(host: HostConfig): string {
  return JSON.stringify([
    host.id,
    host.label,
    host.host,
    host.user ?? null,
    host.port ?? null,
    host.identityFile ?? null,
    host.worktreeBase ?? null,
    host.tmuxPath ?? null,
    host.twPath ?? null,
  ]);
}

function hostCatalogSourceKey(hosts: readonly HostConfig[]): string {
  return JSON.stringify(hosts.map(hostFingerprint));
}

function ownerTag(
  lease: OwnerEpochLease<DashboardBackend>,
): ConnectionCatalogOwnerTag {
  return { owner: lease.owner, epoch: lease.epoch };
}

function stateMatchesLease(
  state: ConnectionCatalogState,
  lease: OwnerEpochLease<DashboardBackend> | null,
): boolean {
  return !!lease &&
    state.owner?.owner === lease.owner &&
    state.owner.epoch === lease.epoch;
}

function stateFromRegistration(
  registration: ConnectionCatalogRegistration,
  lease: OwnerEpochLease<DashboardBackend>,
): ConnectionCatalogState {
  return {
    owner: ownerTag(lease),
    projectPresets: registration.projectPresets,
    hosts: registration.hosts,
    hostsHydrationGeneration: registration.hostsHydrationGeneration,
    catalogReloadRequired: registration.catalogReloadRequired,
    hostsLoadError: registration.hostsLoadError,
    sshHostCandidates: registration.sshHostCandidates,
    hostStatuses: registration.hostStatuses,
    installingHostId: registration.installingHostId,
  };
}

function publishState(
  registration: ConnectionCatalogRegistration,
  lease: OwnerEpochLease<DashboardBackend>,
): void {
  if (!registration.fence.isCurrent(lease)) return;
  const nextState = stateFromRegistration(registration, lease);
  registration.setPublishedState((previous) => (
    registration.fence.isCurrent(lease) ? nextState : previous
  ));
}

function invalidateRequests(registration: ConnectionCatalogRegistration): void {
  registration.projectRequest = null;
  registration.hostCatalogRequest = null;
  registration.candidateRequest = null;
  registration.statusRequest = null;
  registration.installRequest = null;
  registration.installingHostId = null;
}

function resetOwnerCatalog(registration: ConnectionCatalogRegistration): void {
  invalidateRequests(registration);
  registration.projectPresets = [];
  registration.hosts = [];
  registration.hostsHydrationGeneration = 0;
  registration.catalogReloadRequired = false;
  registration.hostsLoadError = null;
  registration.sshHostCandidates = [];
  registration.hostStatuses = {};
  registration.catalogRevision += 1;
  registration.hostSourceKey = hostCatalogSourceKey([]);
  registration.observedStatusSourceKey = null;
}

function connectionRequestIsCurrent(
  registration: ConnectionCatalogRegistration,
  request: ConnectionRequest,
  slot: ConnectionRequest | null,
): boolean {
  return registration.fence.isCurrent(request.lease) && slot === request;
}

function hostCatalogRequestIsCurrent(
  registration: ConnectionCatalogRegistration,
  request: HostCatalogRequest,
): boolean {
  return connectionRequestIsCurrent(
    registration,
    request,
    registration.hostCatalogRequest,
  ) && registration.catalogRevision === request.revision;
}

function candidateRequestIsCurrent(
  registration: ConnectionCatalogRegistration,
  request: HostCandidateRequest,
): boolean {
  return connectionRequestIsCurrent(
    registration,
    request,
    registration.candidateRequest,
  ) && hostCatalogRequestIsCurrent(registration, request.parent);
}

function statusRequestIsCurrent(
  registration: ConnectionCatalogRegistration,
  request: HostStatusRequest,
): boolean {
  return connectionRequestIsCurrent(
    registration,
    request,
    registration.statusRequest,
  ) &&
    registration.catalogRevision === request.revision &&
    registration.hostSourceKey === request.sourceKey;
}

function currentHostFingerprint(
  registration: ConnectionCatalogRegistration,
  hostId: string,
): string | null {
  const host = registration.hosts.find((candidate) => candidate.id === hostId);
  return host ? hostFingerprint(host) : null;
}

function installRequestIsCurrent(
  registration: ConnectionCatalogRegistration,
  request: HostInstallRequest,
): boolean {
  return connectionRequestIsCurrent(
    registration,
    request,
    registration.installRequest,
  ) && currentHostFingerprint(registration, request.hostId) === request.hostFingerprint;
}

function ownerCanStart(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  lease: OwnerEpochLease<DashboardBackend> | null,
): lease is OwnerEpochLease<DashboardBackend> {
  return !!lease &&
    lease.owner === dashboardBackend &&
    registration.backend === dashboardBackend &&
    registration.fence.isCurrent(lease);
}

async function loadProjectPresetsForOwner(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  lease: OwnerEpochLease<DashboardBackend> | null,
): Promise<void> {
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  const request: ConnectionRequest = { lease, token: Symbol("projects") };
  registration.projectRequest = request;
  try {
    const projectPresets = await dashboardBackend.projects.list();
    if (!connectionRequestIsCurrent(
      registration,
      request,
      registration.projectRequest,
    )) return;
    registration.projectPresets = projectPresets;
    publishState(registration, lease);
  } catch {
    if (!connectionRequestIsCurrent(
      registration,
      request,
      registration.projectRequest,
    )) return;
    registration.projectPresets = [];
    publishState(registration, lease);
  }
}

function invalidateStatusForCatalogChange(
  registration: ConnectionCatalogRegistration,
): void {
  registration.statusRequest = null;
  registration.installRequest = null;
  registration.installingHostId = null;
  registration.hostStatuses = {};
}

async function loadHostsForOwner(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  lease: OwnerEpochLease<DashboardBackend> | null,
): Promise<void> {
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  const request: HostCatalogRequest = {
    lease,
    token: Symbol("hosts"),
    revision: registration.catalogRevision,
  };
  registration.hostCatalogRequest = request;
  registration.candidateRequest = null;
  try {
    const hosts = await dashboardBackend.hosts.list();
    if (!hostCatalogRequestIsCurrent(registration, request)) return;
    const nextSourceKey = hostCatalogSourceKey(hosts);
    if (registration.hostSourceKey !== nextSourceKey) {
      invalidateStatusForCatalogChange(registration);
    }
    registration.hosts = hosts;
    registration.hostSourceKey = nextSourceKey;
    registration.catalogReloadRequired = false;
    registration.hostsLoadError = null;
    registration.hostsHydrationGeneration += 1;
    publishState(registration, lease);

    if (!hostCatalogRequestIsCurrent(registration, request)) return;
    const candidateRequest: HostCandidateRequest = {
      lease,
      token: Symbol("host-candidates"),
      parent: request,
    };
    registration.candidateRequest = candidateRequest;
    try {
      const candidates = await dashboardBackend.hosts.candidates();
      if (!candidateRequestIsCurrent(registration, candidateRequest)) return;
      registration.sshHostCandidates = candidates;
      publishState(registration, lease);
    } catch {
      if (!candidateRequestIsCurrent(registration, candidateRequest)) return;
      registration.sshHostCandidates = [];
      publishState(registration, lease);
    }
  } catch (nextError) {
    if (!hostCatalogRequestIsCurrent(registration, request)) return;
    registration.hostsLoadError =
      `Host catalog unavailable: ${String(nextError)}. Retrying automatically.`;
    publishState(registration, lease);
  }
}

function publishHostsForOwner(
  registration: ConnectionCatalogRegistration,
  lease: OwnerEpochLease<DashboardBackend> | null,
  nextHosts: HostConfig[],
): boolean {
  if (!lease || !registration.fence.isCurrent(lease)) return false;
  registration.catalogRevision += 1;
  registration.hostCatalogRequest = null;
  registration.candidateRequest = null;
  invalidateStatusForCatalogChange(registration);
  registration.hosts = nextHosts;
  registration.hostSourceKey = hostCatalogSourceKey(nextHosts);
  registration.observedStatusSourceKey = registration.hostSourceKey;
  registration.catalogReloadRequired = false;
  registration.hostsLoadError = null;
  registration.hostsHydrationGeneration += 1;
  publishState(registration, lease);
  return true;
}

function reloadHostsAfterStaleMutation(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
): void {
  const currentLease = registration.fence.capture(dashboardBackend);
  if (!ownerCanStart(registration, dashboardBackend, currentLease)) return;
  registration.catalogReloadRequired = true;
  publishState(registration, currentLease);
  void loadHostsForOwner(registration, dashboardBackend, currentLease);
}

function invalidateStatusSourceForOwner(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  sourceKey: string,
): void {
  const lease = registration.fence.capture(dashboardBackend);
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  if (sourceKey !== registration.hostSourceKey) return;
  if (registration.observedStatusSourceKey === sourceKey) return;
  registration.observedStatusSourceKey = sourceKey;
  registration.statusRequest = null;
  registration.hostStatuses = {};
  publishState(registration, lease);
}

async function refreshHostStatusesForOwner(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  lease: OwnerEpochLease<DashboardBackend> | null,
): Promise<void> {
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  if (registration.hosts.length === 0 || registration.installRequest) return;
  const request: HostStatusRequest = {
    lease,
    token: Symbol("host-statuses"),
    revision: registration.catalogRevision,
    sourceKey: registration.hostSourceKey,
  };
  registration.statusRequest = request;
  try {
    const statuses = await dashboardBackend.hosts.statuses();
    if (!statusRequestIsCurrent(registration, request)) return;
    registration.hostStatuses = Object.fromEntries(
      statuses.map((status) => [status.id, status]),
    );
    publishState(registration, lease);
  } catch {
    if (!statusRequestIsCurrent(registration, request)) return;
    registration.hostStatuses = {};
    publishState(registration, lease);
  }
}

function reprobeAfterStaleInstall(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  request: HostInstallRequest,
): void {
  const lease = registration.fence.capture(dashboardBackend);
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  if (currentHostFingerprint(registration, request.hostId) !== request.hostFingerprint) return;
  void refreshHostStatusesForOwner(registration, dashboardBackend, lease);
}

async function installRemoteTwForOwner(
  registration: ConnectionCatalogRegistration,
  dashboardBackend: DashboardBackend,
  lease: OwnerEpochLease<DashboardBackend> | null,
  hostId: string,
): Promise<void> {
  if (!ownerCanStart(registration, dashboardBackend, lease)) return;
  if (registration.installRequest) {
    throw new Error("Another tw installation is already in progress.");
  }
  const fingerprint = currentHostFingerprint(registration, hostId);
  if (!fingerprint) return;
  const request: HostInstallRequest = {
    lease,
    token: Symbol(`install:${hostId}`),
    hostId,
    hostFingerprint: fingerprint,
    previousStatus: registration.hostStatuses[hostId] ?? null,
  };
  registration.installRequest = request;
  registration.installingHostId = hostId;
  registration.statusRequest = null;
  const { [hostId]: _staleStatus, ...remainingStatuses } = registration.hostStatuses;
  registration.hostStatuses = remainingStatuses;
  publishState(registration, lease);
  let staleReprobeIssued = false;
  const reprobeStaleInstallOnce = () => {
    if (staleReprobeIssued) return;
    staleReprobeIssued = true;
    reprobeAfterStaleInstall(registration, dashboardBackend, request);
  };
  try {
    const status = await dashboardBackend.hosts.installTw(hostId);
    if (!installRequestIsCurrent(registration, request)) {
      reprobeStaleInstallOnce();
      if (registration.fence.isCurrent(request.lease)) {
        throw new Error("Host catalog changed while tw installation was running.");
      }
      return;
    }
    registration.hostStatuses = {
      ...registration.hostStatuses,
      [status.id]: status,
    };
    publishState(registration, lease);
  } catch (error) {
    if (installRequestIsCurrent(registration, request)) {
      const current = request.previousStatus;
      if (current) {
        registration.hostStatuses = {
          ...registration.hostStatuses,
          [hostId]: {
            ...current,
            twAvailable: false,
            twError: String(error),
          },
        };
        publishState(registration, lease);
      }
    } else {
      reprobeStaleInstallOnce();
    }
    throw error;
  } finally {
    if (installRequestIsCurrent(registration, request)) {
      registration.installRequest = null;
      registration.installingHostId = null;
      publishState(registration, lease);
    }
  }
}

function createConnectionCatalogRegistration(
  setPublishedState: Dispatch<SetStateAction<ConnectionCatalogState>>,
): ConnectionCatalogRegistration {
  return {
    fence: createOwnerEpochLeaseController<DashboardBackend>(),
    backend: null,
    setPublishedState,
    projectPresets: [],
    hosts: [],
    hostsHydrationGeneration: 0,
    catalogReloadRequired: false,
    hostsLoadError: null,
    sshHostCandidates: [],
    hostStatuses: {},
    installingHostId: null,
    catalogRevision: 0,
    hostSourceKey: hostCatalogSourceKey([]),
    observedStatusSourceKey: null,
    projectRequest: null,
    hostCatalogRequest: null,
    candidateRequest: null,
    statusRequest: null,
    installRequest: null,
  };
}

export function useConnectionCatalog(
  dashboardBackend: DashboardBackend,
): ConnectionCatalogController {
  const [publishedState, setPublishedState] =
    useState<ConnectionCatalogState>(EMPTY_STATE);
  const [registration] = useState(() =>
    createConnectionCatalogRegistration(setPublishedState)
  );
  const [ownerPhase] = useState<ConnectionCatalogOwnerPhaseHandle>(() => ({
    registration,
  }));
  const renderLease = registration.fence.capture(dashboardBackend);
  const visibleState = stateMatchesLease(publishedState, renderLease)
    ? publishedState
    : EMPTY_STATE;

  const loadProjectPresets = useCallback(
    () => loadProjectPresetsForOwner(registration, dashboardBackend, renderLease),
    [dashboardBackend, registration, renderLease],
  );
  const onHostsMutationSettled = useCallback(
    (nextHosts: HostConfig[], acceptPayload: boolean) => {
      if (
        acceptPayload &&
        publishHostsForOwner(registration, renderLease, nextHosts)
      ) return true;
      reloadHostsAfterStaleMutation(registration, dashboardBackend);
      return false;
    },
    [dashboardBackend, registration, renderLease],
  );
  const installRemoteTw = useCallback(
    (hostId: string) => installRemoteTwForOwner(
      registration,
      dashboardBackend,
      renderLease,
      hostId,
    ),
    [dashboardBackend, registration, renderLease],
  );

  return {
    projectPresets: visibleState.projectPresets,
    loadProjectPresets,
    hosts: visibleState.hosts,
    hostsHydrationGeneration: visibleState.hostsHydrationGeneration,
    catalogReloadRequired: visibleState.catalogReloadRequired,
    hostsLoadError: visibleState.hostsLoadError,
    onHostsMutationSettled,
    sshHostCandidates: visibleState.sshHostCandidates,
    hostStatuses: visibleState.hostStatuses,
    installingHostId: visibleState.installingHostId,
    installRemoteTw,
    ownerEpochKey: visibleState.owner
      ? `connection:${visibleState.owner.epoch}`
      : "connection:pending",
    ownerPhase,
  };
}

export function useConnectionCatalogOwnerPhase(
  ownerPhase: ConnectionCatalogOwnerPhaseHandle,
  dashboardBackend: DashboardBackend,
): void {
  const { registration } = ownerPhase;
  useLayoutEffect(() => {
    registration.backend = dashboardBackend;
    const ownerCommit = registration.fence.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    resetOwnerCatalog(registration);
    if (ownerCommit.lease) {
      publishState(registration, ownerCommit.lease);
    } else {
      registration.setPublishedState(EMPTY_STATE);
    }
  }, [dashboardBackend, ownerPhase, registration]);

  useLayoutEffect(() => {
    const activation = registration.fence.activate();
    const lease = registration.backend
      ? registration.fence.capture(registration.backend)
      : null;
    if (lease) publishState(registration, lease);
    return () => {
      if (!registration.fence.deactivate(activation)) return;
      invalidateRequests(registration);
      registration.hostStatuses = {};
      registration.hostsLoadError = null;
      registration.observedStatusSourceKey = null;
    };
  }, [ownerPhase, registration]);
}

export function useConnectionCatalogSyncPhase(
  connectionCatalog: ConnectionCatalogController,
  dashboardBackend: DashboardBackend,
): void {
  const { registration } = connectionCatalog.ownerPhase;
  useEffect(() => {
    const lease = registration.fence.capture(dashboardBackend);
    void loadProjectPresetsForOwner(registration, dashboardBackend, lease);
  }, [dashboardBackend, registration]);

  const loadHosts = useCallback(() => {
    const lease = registration.fence.capture(dashboardBackend);
    return loadHostsForOwner(registration, dashboardBackend, lease);
  }, [dashboardBackend, registration]);
  useVisibilityAwarePolling(loadHosts, {
    enabled: connectionCatalog.hostsHydrationGeneration === 0 ||
      connectionCatalog.catalogReloadRequired,
    visibleIntervalMs: HOST_CATALOG_RETRY_MS,
    hiddenIntervalMs: HOST_CATALOG_HIDDEN_RETRY_MS,
    restartKey: dashboardBackend,
  });

  const hostStatusSourceKey = useMemo(
    () => hostCatalogSourceKey(connectionCatalog.hosts),
    [connectionCatalog.hosts],
  );
  useEffect(() => {
    invalidateStatusSourceForOwner(
      registration,
      dashboardBackend,
      hostStatusSourceKey,
    );
  }, [dashboardBackend, hostStatusSourceKey, registration]);

  const refreshHostStatuses = useCallback(() => {
    const lease = registration.fence.capture(dashboardBackend);
    return refreshHostStatusesForOwner(registration, dashboardBackend, lease);
  }, [dashboardBackend, registration]);
  useVisibilityAwarePolling(refreshHostStatuses, {
    enabled: connectionCatalog.hosts.length > 0 &&
      connectionCatalog.installingHostId === null,
    visibleIntervalMs: HOST_STATUS_REFRESH_MS,
    hiddenIntervalMs: HOST_STATUS_HIDDEN_REFRESH_MS,
    refreshKey: hostStatusSourceKey,
  });
}
