import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { DashboardBackend } from "../../platform";
import type {
  WorkspaceBranchSource,
  WorkspaceBranchValue,
} from "../model/workspacePresentation";
import {
  createOwnerEpochLeaseController,
  type OwnerEpochLease,
  type OwnerEpochLeaseController,
} from "../ownerEpochLease";

type WorkspacePresentationPublishedOwner = Readonly<{
  owner: DashboardBackend;
  epoch: number;
}>;

type WorkspaceHomeRequest = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  token: symbol;
}>;

type WorkspaceBranchBinding = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  sourceKey: string;
  token: symbol;
}>;

type WorkspaceBranchRequest = Readonly<{
  lease: OwnerEpochLease<DashboardBackend>;
  sourceKey: string;
  token: symbol;
}>;

type WorkspacePresentationRegistration = {
  fence: OwnerEpochLeaseController<DashboardBackend>;
  committedBackend: DashboardBackend | null;
  homeRequest: WorkspaceHomeRequest | null;
  branchBinding: WorkspaceBranchBinding | null;
  branchRequest: WorkspaceBranchRequest | null;
};

type WorkspacePresentationOwnerPhaseHandle = Readonly<{
  registration: WorkspacePresentationRegistration;
  setPublishedOwner: Dispatch<
    SetStateAction<WorkspacePresentationPublishedOwner | null>
  >;
  setHomeDirectory: Dispatch<SetStateAction<string | null>>;
  setWorkspaceBranch: Dispatch<SetStateAction<WorkspaceBranchValue | null>>;
}>;

type WorkspacePresentationController = Readonly<{
  ownerReady: boolean;
  homeDirectory: string | null;
  workspaceBranch: WorkspaceBranchValue | null;
  ownerPhase: WorkspacePresentationOwnerPhaseHandle;
}>;

function homeRequestIsCurrent(
  registration: WorkspacePresentationRegistration,
  request: WorkspaceHomeRequest,
): boolean {
  return registration.fence.isCurrent(request.lease) &&
    registration.homeRequest === request;
}

function branchRequestIsCurrent(
  registration: WorkspacePresentationRegistration,
  request: WorkspaceBranchRequest,
): boolean {
  return registration.fence.isCurrent(request.lease) &&
    registration.branchRequest === request;
}

export function useWorkspacePresentation(
  dashboardBackend: DashboardBackend,
): WorkspacePresentationController {
  const [homeDirectory, setHomeDirectory] = useState<string | null>(null);
  const [workspaceBranch, setWorkspaceBranch] =
    useState<WorkspaceBranchValue | null>(null);
  const [publishedOwner, setPublishedOwner] =
    useState<WorkspacePresentationPublishedOwner | null>(null);
  const [registration] = useState<WorkspacePresentationRegistration>(() => ({
    fence: createOwnerEpochLeaseController<DashboardBackend>(),
    committedBackend: null,
    homeRequest: null,
    branchBinding: null,
    branchRequest: null,
  }));
  const [ownerPhase] = useState<WorkspacePresentationOwnerPhaseHandle>(() => ({
    registration,
    setPublishedOwner,
    setHomeDirectory,
    setWorkspaceBranch,
  }));
  const lease = registration.fence.capture(dashboardBackend);
  const ownerReady = !!lease &&
    publishedOwner?.owner === lease.owner &&
    publishedOwner.epoch === lease.epoch;

  return {
    ownerReady,
    homeDirectory: ownerReady ? homeDirectory : null,
    workspaceBranch: ownerReady ? workspaceBranch : null,
    ownerPhase,
  };
}

export function useWorkspacePresentationOwnerPhase(
  ownerPhase: WorkspacePresentationOwnerPhaseHandle,
  dashboardBackend: DashboardBackend,
): void {
  const {
    registration,
    setPublishedOwner,
    setHomeDirectory,
    setWorkspaceBranch,
  } = ownerPhase;

  useLayoutEffect(() => {
    registration.committedBackend = dashboardBackend;
    const ownerCommit = registration.fence.commit(dashboardBackend);
    if (!ownerCommit.changed) return;
    registration.homeRequest = null;
    registration.branchBinding = null;
    registration.branchRequest = null;
    setHomeDirectory(null);
    setWorkspaceBranch(null);
    setPublishedOwner(ownerCommit.lease);
  }, [dashboardBackend, ownerPhase, registration]);

  useLayoutEffect(() => {
    const activation = registration.fence.activate();
    const lease = registration.committedBackend
      ? registration.fence.capture(registration.committedBackend)
      : null;
    setPublishedOwner(lease);
    return () => {
      if (!registration.fence.deactivate(activation)) return;
      registration.homeRequest = null;
      registration.branchBinding = null;
      registration.branchRequest = null;
    };
  }, [ownerPhase, registration]);
}

export function useWorkspaceHomePhase(
  controller: WorkspacePresentationController,
  dashboardBackend: DashboardBackend,
): void {
  const { registration, setHomeDirectory } = controller.ownerPhase;

  useEffect(() => {
    const lease = registration.fence.capture(dashboardBackend);
    if (!lease || !registration.fence.isCurrent(lease)) return;
    const request: WorkspaceHomeRequest = {
      lease,
      token: Symbol("home"),
    };
    registration.homeRequest = request;
    void dashboardBackend.persistence.homeDirectory()
      .then((homeDirectory) => {
        if (!homeRequestIsCurrent(registration, request)) return;
        setHomeDirectory((previous) => (
          homeRequestIsCurrent(registration, request)
            ? homeDirectory
            : previous
        ));
      })
      .catch(() => {});
    return () => {
      if (registration.homeRequest === request) registration.homeRequest = null;
    };
  }, [dashboardBackend, registration, setHomeDirectory]);
}

export function useWorkspaceBranchPhase(
  controller: WorkspacePresentationController,
  dashboardBackend: DashboardBackend,
  source: WorkspaceBranchSource,
): (branch: string | null) => void {
  const { registration, setWorkspaceBranch } = controller.ownerPhase;
  const lease = registration.fence.capture(dashboardBackend);
  const sourceCwd = source.kind === "workspace" ? source.cwd : null;
  const sourceHostId = source.kind === "workspace" ? source.hostId : null;
  const binding = useMemo<WorkspaceBranchBinding | null>(() => (
    lease
      ? { lease, sourceKey: source.key, token: Symbol(source.key) }
      : null
  ), [lease, source.key]);
  const publishWorkspaceBranch = useCallback((branch: string | null) => {
    if (!binding || !registration.fence.isCurrent(binding.lease)) return;
    if (registration.branchBinding !== binding) return;
    setWorkspaceBranch((previous) => (
      registration.fence.isCurrent(binding.lease) &&
      registration.branchBinding === binding
        ? { sourceKey: binding.sourceKey, value: branch }
        : previous
    ));
  }, [binding, registration, setWorkspaceBranch]);

  useEffect(() => {
    const queryLease = registration.fence.capture(dashboardBackend);
    if (!queryLease || !registration.fence.isCurrent(queryLease)) return;
    const request: WorkspaceBranchRequest = {
      lease: queryLease,
      sourceKey: source.key,
      token: Symbol(source.key),
    };
    registration.branchBinding = binding &&
        registration.fence.isCurrent(binding.lease)
      ? binding
      : null;
    registration.branchRequest = request;
    setWorkspaceBranch((previous) => (
      branchRequestIsCurrent(registration, request)
        ? { sourceKey: request.sourceKey, value: null }
        : previous
    ));
    if (source.kind === "workspace") {
      void dashboardBackend.git.status(source.cwd, source.hostId)
        .then((status) => {
          if (!branchRequestIsCurrent(registration, request)) return;
          setWorkspaceBranch((previous) => (
            branchRequestIsCurrent(registration, request)
              ? { sourceKey: request.sourceKey, value: status?.branch || null }
              : previous
          ));
        })
        .catch(() => {
          if (!branchRequestIsCurrent(registration, request)) return;
          setWorkspaceBranch((previous) => (
            branchRequestIsCurrent(registration, request)
              ? { sourceKey: request.sourceKey, value: null }
              : previous
          ));
        });
    }
    return () => {
      if (registration.branchRequest === request) {
        registration.branchRequest = null;
      }
      if (registration.branchBinding === binding) {
        registration.branchBinding = null;
      }
    };
  }, [
    dashboardBackend,
    binding,
    registration,
    setWorkspaceBranch,
    sourceHostId,
    source.key,
    source.kind,
    sourceCwd,
  ]);

  return publishWorkspaceBranch;
}
