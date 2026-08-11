import {
  AlertCircle,
  Check,
  Download,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { MenuSelect, type MenuOption } from "../../MenuSelect";
import type {
  HostConfig,
  HostStatus,
  MobileRelayV2SelfHostedStatus,
  PlainTerminal,
  Session,
} from "../../platform";
import { useDashboardBackend } from "../../platform";
import "../design/tokens.css";
import "./ConnectionsSettings.css";
import {
  createConnectionsAsyncCoordinator,
  hostCatalogFingerprint,
} from "./connectionsAsyncCoordinator";
import {
  calculateHostRemovalImpact,
  createEmptyHostDraft,
  hostConfigToDraft,
  sshCandidateToDraft,
  validateHostDraft,
  type HostDraft,
  type HostDraftErrors,
  type HostDraftField,
} from "./connectionsModel";
import { RelayV2EnrollmentPreviewPanel } from "./RelayV2EnrollmentPreviewPanel";
import { RelayConnectionOverviewCard } from "./RelayConnectionOverviewCard";
import type { RelayConnectionOverviewPrimaryAction } from "./relayConnectionOverviewModel";
import {
  relayV2SelfHostedConnectorDesiredRunning,
  relayV2SelfHostedStackLabel,
  relayV2StackEffective,
} from "./relayV2SelfHostedModel";
import { RelayV2SelfHostedPanel } from "./RelayV2SelfHostedPanel";
import { useRelayConnectionOverview } from "./useRelayConnectionOverview";
import { useRelayV2EnrollmentController } from "./useRelayV2EnrollmentController";

type HostEditorMode = "view" | "add" | "edit";
type ConnectionTab = "hosts" | "relay";
type AsyncNoticeTone = "pending" | "success" | "error";

interface AsyncNotice {
  tone: AsyncNoticeTone;
  message: string;
}

export interface ConnectionsSettingsProps {
  hosts: readonly HostConfig[];
  hostStatuses: Readonly<Record<string, HostStatus>>;
  hostCatalogError?: string | null;
  sshHostCandidates: readonly HostConfig[];
  sessions: readonly Session[];
  terminals: readonly PlainTerminal[];
  onHostsMutationSettled: (
    hosts: HostConfig[],
    acceptPayload: boolean,
  ) => boolean;
  installingHostId: string | null;
  onInstallTw: (hostId: string) => void | Promise<void>;
}

interface HostFieldDefinition {
  field: HostDraftField;
  label: string;
  placeholder: string;
  type?: "text" | "number";
  hint?: string;
}

const HOST_FIELDS: readonly HostFieldDefinition[] = [
  { field: "id", label: "Host ID", placeholder: "build-mac", hint: "Stable ID used by sessions and layouts." },
  { field: "label", label: "Label", placeholder: "Build Mac" },
  { field: "host", label: "Host", placeholder: "build.example.com" },
  { field: "user", label: "User", placeholder: "developer" },
  { field: "port", label: "Port", placeholder: "22", type: "number" },
  { field: "identityFile", label: "Identity file", placeholder: "~/.ssh/id_ed25519" },
  { field: "worktreeBase", label: "Worktree base", placeholder: "~/worktrees" },
  { field: "tmuxPath", label: "tmux path", placeholder: "tmux" },
  { field: "twPath", label: "tw path", placeholder: "tw" },
] as const;

// The underlying Rust status command runs load_config + probe per call, and
// probe_status shells out over SSH to the devbox. Poll coarsely (15s) so the
// relay tab does not hammer the remote host while it stays open.
const RELAY_V2_STATUS_POLL_MS = 15_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusIcon(tone: AsyncNoticeTone): ReactNode {
  if (tone === "pending") {
    return <LoaderCircle className="connections-spin" aria-hidden="true" size={15} />;
  }
  if (tone === "success") return <Check aria-hidden="true" size={15} />;
  return <AlertCircle aria-hidden="true" size={15} />;
}

function HostStateIcon({ status }: { status: HostStatus | null }) {
  if (!status) return <Server aria-hidden="true" size={16} />;
  return status.reachable
    ? <Wifi aria-hidden="true" size={16} />
    : <WifiOff aria-hidden="true" size={16} />;
}

export function ConnectionsSettings({
  hosts,
  hostStatuses,
  hostCatalogError,
  sshHostCandidates,
  sessions,
  terminals,
  onHostsMutationSettled,
  installingHostId,
  onInstallTw,
}: ConnectionsSettingsProps) {
  const dashboardBackend = useDashboardBackend();
  const [activeTab, setActiveTab] = useState<ConnectionTab>("hosts");
  const [selectedHostId, setSelectedHostId] = useState<string | null>(hosts[0]?.id ?? null);
  const [mode, setMode] = useState<HostEditorMode>(hosts.length ? "view" : "add");
  const [draft, setDraft] = useState<HostDraft>(() =>
    hosts[0] ? hostConfigToDraft(hosts[0]) : createEmptyHostDraft(),
  );
  const [draftErrors, setDraftErrors] = useState<HostDraftErrors>({});
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [hostNotice, setHostNotice] = useState<AsyncNotice | null>(null);
  const [testedStatus, setTestedStatus] = useState<HostStatus | null>(null);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [relayAdvancedOpen, setRelayAdvancedOpen] = useState(false);
  const [copiedEnrollmentLink, setCopiedEnrollmentLink] = useState(false);
  const copyEnrollmentLinkTimerRef = useRef<number | null>(null);
  const [relayV2Status, setRelayV2Status] = useState<MobileRelayV2SelfHostedStatus | null>(null);
  const asyncCoordinatorRef = useRef(createConnectionsAsyncCoordinator());
  const currentHostCatalogFingerprint = hostCatalogFingerprint(hosts);
  const hostCatalogFingerprintRef = useRef(currentHostCatalogFingerprint);
  const acceptedHostCatalogFingerprintRef = useRef<string | null>(null);

  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const selectedStatus = selectedHostId ? hostStatuses[selectedHostId] ?? null : null;
  const selectedCandidate = sshHostCandidates.find(
    (candidate) => candidate.id === selectedCandidateId,
  ) ?? null;
  const candidateOptions = useMemo<MenuOption[]>(() => [
    { value: "", label: "Choose a host…" },
    ...sshHostCandidates.map((candidate) => ({
      value: candidate.id,
      label: candidate.label || candidate.id,
      detail: candidate.user
        ? `${candidate.user}@${candidate.host || candidate.id}`
        : candidate.host || candidate.id,
    })),
  ], [sshHostCandidates]);
  const hostImpact = useMemo(
    () => calculateHostRemovalImpact(selectedHostId ?? "", sessions, terminals),
    [selectedHostId, sessions, terminals],
  );
  const relayV2Effective = relayV2StackEffective(relayV2Status);
  const relayStackLabel = relayV2SelfHostedStackLabel(relayV2Status);
  const relayV2ConnectorDesired = relayV2SelfHostedConnectorDesiredRunning(relayV2Status);
  const hostBusy = hostNotice?.tone === "pending";

  useEffect(() => () => {
    asyncCoordinatorRef.current.invalidateAll();
  }, []);

  // Immediate fetch on mount; the interval below keeps it fresh while the
  // Relay tab is visible so the overview is never stuck on a mount-time
  // snapshot (e.g. "Relay center is not running" after a repair fixed it).
  useEffect(() => {
    let active = true;
    void dashboardBackend.relay.v2Deployment.status().then((next) => {
      if (active) setRelayV2Status(next);
    }).catch(() => {
      if (active) setRelayV2Status(null);
    });
    return () => {
      active = false;
    };
  }, [dashboardBackend]);

  useEffect(() => {
    if (activeTab !== "relay") return;
    const timer = window.setInterval(() => {
      void dashboardBackend.relay.v2Deployment.status().then((next) => {
        setRelayV2Status(next);
      }).catch(() => {
        setRelayV2Status(null);
      });
    }, RELAY_V2_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [dashboardBackend, activeTab]);

  // One shared Relay v2 management controller drives both the overview card and
  // the Advanced enrollment panel, so both stay in sync on the same polled state.
  const relayV2Controller = useRelayV2EnrollmentController();

  // Feed freshly read deployment statuses (repair results, post-repair
  // refreshes) back into relayV2Status so the readiness branch is current.
  const handleSelfHostedStatus = useCallback((status: MobileRelayV2SelfHostedStatus) => {
    setRelayV2Status(status);
  }, []);
  const relayOverview = useRelayConnectionOverview(
    relayV2Status,
    relayV2Controller,
    handleSelfHostedStatus,
  );

  useEffect(() => {
    if (hostCatalogFingerprintRef.current === currentHostCatalogFingerprint) return;
    hostCatalogFingerprintRef.current = currentHostCatalogFingerprint;

    if (acceptedHostCatalogFingerprintRef.current === currentHostCatalogFingerprint) {
      acceptedHostCatalogFingerprintRef.current = null;
      return;
    }

    acceptedHostCatalogFingerprintRef.current = null;
    asyncCoordinatorRef.current.invalidate("hostFeedback");
    asyncCoordinatorRef.current.invalidate("hostCatalog");
    setHostNotice((current) => current?.tone === "pending" ? null : current);
    setTestedStatus(null);
    setDeleteConfirmationOpen(false);
  }, [currentHostCatalogFingerprint]);

  useEffect(() => {
    if (mode === "add") return;
    const current = hosts.find((host) => host.id === selectedHostId);
    if (current) {
      if (mode === "view") setDraft(hostConfigToDraft(current));
      return;
    }

    const nextHost = hosts[0] ?? null;
    asyncCoordinatorRef.current.invalidate("hostFeedback");
    setSelectedHostId(nextHost?.id ?? null);
    setDraft(nextHost ? hostConfigToDraft(nextHost) : createEmptyHostDraft());
    setMode(nextHost ? "view" : "add");
    setDraftErrors({});
    setHostNotice(null);
    setTestedStatus(null);
    setDeleteConfirmationOpen(false);
  }, [hosts, mode, selectedHostId]);

  const resetFeedback = () => {
    asyncCoordinatorRef.current.invalidate("hostFeedback");
    setDraftErrors({});
    setHostNotice(null);
    setTestedStatus(null);
    setDeleteConfirmationOpen(false);
  };

  const selectHost = (host: HostConfig) => {
    setSelectedHostId(host.id);
    setDraft(hostConfigToDraft(host));
    setMode("view");
    setSelectedCandidateId("");
    resetFeedback();
  };

  const beginAdd = () => {
    setSelectedHostId(null);
    setDraft(createEmptyHostDraft());
    setMode("add");
    setSelectedCandidateId("");
    resetFeedback();
  };

  const beginEdit = () => {
    if (!selectedHost) return;
    setDraft(hostConfigToDraft(selectedHost));
    setMode("edit");
    resetFeedback();
  };

  const cancelEdit = () => {
    const fallbackHost = selectedHost ?? hosts[0] ?? null;
    setSelectedHostId(fallbackHost?.id ?? null);
    setDraft(fallbackHost ? hostConfigToDraft(fallbackHost) : createEmptyHostDraft());
    setMode(fallbackHost ? "view" : "add");
    setSelectedCandidateId("");
    resetFeedback();
  };

  const updateDraft = (field: HostDraftField, value: string) => {
    asyncCoordinatorRef.current.invalidate("hostFeedback");
    setDraft((current) => ({ ...current, [field]: value }));
    setDraftErrors((current) => ({ ...current, [field]: undefined }));
    setHostNotice(null);
    setTestedStatus(null);
  };

  const applyCandidate = () => {
    if (!selectedCandidate) return;
    asyncCoordinatorRef.current.invalidate("hostFeedback");
    setDraft(sshCandidateToDraft(selectedCandidate));
    setDraftErrors({});
    setHostNotice({ tone: "success", message: `Prefilled from ${selectedCandidate.label || selectedCandidate.id}.` });
    setTestedStatus(null);
  };

  const validateCurrentHost = (forSave: boolean) => {
    const validation = validateHostDraft(draft, {
      existingHosts: forSave ? hosts : [],
      editingHostId: mode === "edit" ? selectedHostId : null,
    });
    setDraftErrors(validation.errors);
    if (!validation.valid) {
      setHostNotice({ tone: "error", message: "Review the highlighted host fields." });
    }
    return validation;
  };

  const issueHostFeedbackOperation = (
    intent: "test" | "save" | "delete" | "install",
    ...identity: ReadonlyArray<string | number | boolean | null | undefined>
  ) => asyncCoordinatorRef.current.issue("hostFeedback", intent, ...identity);

  const issueHostCatalogMutation = (
    intent: "save" | "delete",
    ...identity: ReadonlyArray<string | number | boolean | null | undefined>
  ) => asyncCoordinatorRef.current.issue(
    "hostCatalog",
    intent,
    hostCatalogFingerprintRef.current,
    ...identity,
  );

  const testConnection = async () => {
    const feedbackRequest = issueHostFeedbackOperation(
      "test",
      selectedHostId,
      mode,
      JSON.stringify(draft),
    );
    const validation = validateCurrentHost(false);
    if (!validation.valid) return;

    setHostNotice({ tone: "pending", message: "Testing the SSH connection…" });
    setTestedStatus(null);
    try {
      const status = await dashboardBackend.hosts.test(validation.value);
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setTestedStatus(status);
      setHostNotice(status.reachable
        ? {
            tone: "success",
            message: `Connected${status.latencyMs === null ? "" : ` in ${status.latencyMs} ms`}.`,
          }
        : { tone: "error", message: status.error || "SSH connection failed." });
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const saveHost = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "view") return;
    const feedbackRequest = issueHostFeedbackOperation(
      "save",
      selectedHostId,
      mode,
      JSON.stringify(draft),
    );
    const validation = validateCurrentHost(true);
    if (!validation.valid) return;
    const operationMode = mode;
    const catalogRequest = issueHostCatalogMutation(
      "save",
      selectedHostId,
      operationMode,
      validation.value.id,
    );

    setHostNotice({
      tone: "pending",
      message: operationMode === "add" ? "Adding host…" : "Saving host changes…",
    });
    try {
      const updatedHosts = operationMode === "add"
        ? await dashboardBackend.hosts.add(validation.value)
        : await dashboardBackend.hosts.update(validation.value);
      const payloadAccepted = onHostsMutationSettled(
        updatedHosts,
        asyncCoordinatorRef.current.isCurrent(catalogRequest),
      );
      if (payloadAccepted) {
        acceptedHostCatalogFingerprintRef.current = hostCatalogFingerprint(updatedHosts);
      }
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setSelectedHostId(validation.value.id);
      setDraft(hostConfigToDraft(validation.value));
      setMode("view");
      setDraftErrors({});
      setHostNotice({
        tone: "success",
        message: operationMode === "add" ? "Host added." : "Host changes saved.",
      });
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const deleteHost = async () => {
    if (!selectedHost) return;
    const hostToDelete = selectedHost;
    const feedbackRequest = issueHostFeedbackOperation("delete", hostToDelete.id);
    const catalogRequest = issueHostCatalogMutation("delete", hostToDelete.id);
    setHostNotice({ tone: "pending", message: `Removing ${hostToDelete.label}…` });
    try {
      const updatedHosts = await dashboardBackend.hosts.remove(hostToDelete.id);
      const payloadAccepted = onHostsMutationSettled(
        updatedHosts,
        asyncCoordinatorRef.current.isCurrent(catalogRequest),
      );
      if (payloadAccepted) {
        acceptedHostCatalogFingerprintRef.current = hostCatalogFingerprint(updatedHosts);
      }
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      const nextHost = updatedHosts[0] ?? null;
      setSelectedHostId(nextHost?.id ?? null);
      setDraft(nextHost ? hostConfigToDraft(nextHost) : createEmptyHostDraft());
      setMode(nextHost ? "view" : "add");
      setDeleteConfirmationOpen(false);
      setHostNotice({ tone: "success", message: `${hostToDelete.label} was removed.` });
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const installTw = async () => {
    if (!selectedHost) return;
    const hostToInstall = selectedHost;
    const feedbackRequest = issueHostFeedbackOperation("install", hostToInstall.id);
    setHostNotice({ tone: "pending", message: `Installing tw on ${hostToInstall.label}…` });
    try {
      await onInstallTw(hostToInstall.id);
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setHostNotice({ tone: "success", message: "tw installation finished. Status will refresh shortly." });
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(feedbackRequest)) return;
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const handleRelayOverviewPrimaryAction = (action: RelayConnectionOverviewPrimaryAction) => {
    if (action.kind === "setup") {
      setRelayAdvancedOpen(true);
    } else if (action.kind === "fix") {
      void relayOverview.runConnectionRepair();
    } else if (action.kind === "show_qr") {
      void relayOverview.showPairingQr();
    }
  };

  const handleCopyEnrollmentLink = (handle: string) => {
    relayOverview.copyEnrollmentLink(handle);
    setCopiedEnrollmentLink(true);
    if (copyEnrollmentLinkTimerRef.current !== null) {
      window.clearTimeout(copyEnrollmentLinkTimerRef.current);
    }
    copyEnrollmentLinkTimerRef.current = window.setTimeout(
      () => setCopiedEnrollmentLink(false),
      1_200,
    );
  };

  const handleRevokeClientGrant = (grantId: string) => {
    relayOverview.revokeClientGrant(grantId);
  };

  const handleConnectionTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentTab: ConnectionTab,
  ) => {
    let nextTab: ConnectionTab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextTab = currentTab === "hosts" ? "relay" : "hosts";
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextTab = currentTab === "hosts" ? "relay" : "hosts";
    } else if (event.key === "Home") {
      nextTab = "hosts";
    } else if (event.key === "End") {
      nextTab = "relay";
    }
    if (!nextTab || nextTab === currentTab) return;
    event.preventDefault();
    setActiveTab(nextTab);
    window.requestAnimationFrame(() => {
      document.getElementById(`connections-tab-${nextTab}`)?.focus();
    });
  };

  return (
    <div className="connections-settings">
      <div className="connections-tabs" role="tablist" aria-label="Connection settings">
        <button
          id="connections-tab-hosts"
          type="button"
          role="tab"
          aria-selected={activeTab === "hosts"}
          aria-controls="connections-active-panel"
          tabIndex={activeTab === "hosts" ? 0 : -1}
          className="connections-tabs__item"
          onClick={() => setActiveTab("hosts")}
          onKeyDown={(event) => handleConnectionTabKeyDown(event, "hosts")}
        >
          <Server aria-hidden="true" size={15} />
          Hosts
        </button>
        <button
          id="connections-tab-relay"
          type="button"
          role="tab"
          aria-selected={activeTab === "relay"}
          aria-controls="connections-active-panel"
          tabIndex={activeTab === "relay" ? 0 : -1}
          className="connections-tabs__item"
          onClick={() => setActiveTab("relay")}
          onKeyDown={(event) => handleConnectionTabKeyDown(event, "relay")}
        >
          <Radio aria-hidden="true" size={15} />
          Relay
        </button>
      </div>

      {activeTab === "hosts" ? (
        <div
          id="connections-active-panel"
          className="connections-panel"
          role="tabpanel"
          aria-labelledby="connections-tab-hosts"
        >
          <div className="connections-heading-row">
            <div>
              <h3>SSH hosts</h3>
              <p>Remote targets used by worktrees, sessions, and terminals.</p>
            </div>
            <button type="button" className="connections-button connections-button--primary" onClick={beginAdd}>
              <Plus aria-hidden="true" size={15} />
              Add host
            </button>
          </div>

          {hostCatalogError && (
            <div className="connections-notice connections-notice--error" role="alert">
              <AlertCircle aria-hidden="true" size={15} />
              <span>{hostCatalogError}</span>
            </div>
          )}

          {hosts.length > 0 && (
            <div className="connections-host-list" role="list" aria-label="Configured SSH hosts">
              {hosts.map((host) => {
                const status = hostStatuses[host.id] ?? null;
                const selected = selectedHostId === host.id && mode !== "add";
                return (
                  <div key={host.id} className="connections-host-list__item" role="listitem">
                    <button
                      type="button"
                      className="connections-host-row"
                      aria-current={selected ? "true" : undefined}
                      onClick={() => selectHost(host)}
                    >
                      <span className={`connections-host-row__icon connections-host-row__icon--${status?.reachable ? "online" : status ? "offline" : "unknown"}`}>
                        <HostStateIcon status={status} />
                      </span>
                      <span className="connections-host-row__copy">
                        <strong>{host.label}</strong>
                        <span>{host.user ? `${host.user}@` : ""}{host.host}{host.port ? `:${host.port}` : ""}</span>
                      </span>
                      <span className="connections-host-row__state">
                        {status?.reachable ? `${status.latencyMs ?? "—"} ms` : status ? "Offline" : "Unchecked"}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <form className="connections-card connections-host-form" onSubmit={saveHost}>
            <div className="connections-card__header">
              <div>
                <h4>{mode === "add" ? "New host" : selectedHost?.label ?? "Host details"}</h4>
                <p>{mode === "view" ? "Connection configuration" : mode === "edit" ? "Update the saved connection" : "Enter a target manually or prefill from SSH config"}</p>
              </div>
              {mode === "view" && selectedHost && (
                <button type="button" className="connections-icon-button" aria-label="Edit host" onClick={beginEdit}>
                  <Pencil aria-hidden="true" size={15} />
                </button>
              )}
            </div>

            {mode === "add" && sshHostCandidates.length > 0 && (
              <div className="connections-candidate">
                <div className="connections-candidate__field">
                  <span>SSH config candidate</span>
                  <MenuSelect
                    ariaLabel="SSH config candidate"
                    className="connections-menu-select"
                    value={selectedCandidateId}
                    options={candidateOptions}
                    onChange={setSelectedCandidateId}
                    disabled={hostBusy}
                  />
                </div>
                <button
                  type="button"
                  className="connections-button"
                  disabled={!selectedCandidate || hostBusy}
                  onClick={applyCandidate}
                >
                  <RotateCcw aria-hidden="true" size={14} />
                  Prefill
                </button>
              </div>
            )}

            <div className="connections-fields">
              {HOST_FIELDS.map(({ field, label, placeholder, type = "text", hint }) => {
                const immutableId = field === "id" && mode === "edit";
                const inputId = `connection-host-${field}`;
                const errorId = `${inputId}-error`;
                return (
                  <label key={field} className={`connections-field${draftErrors[field] ? " connections-field--error" : ""}`} htmlFor={inputId}>
                    <span>{label}</span>
                    <input
                      id={inputId}
                      type={type}
                      min={type === "number" ? 1 : undefined}
                      max={type === "number" ? 65_535 : undefined}
                      value={draft[field]}
                      placeholder={placeholder}
                      readOnly={immutableId}
                      disabled={mode === "view" || hostBusy}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(draftErrors[field])}
                      aria-describedby={draftErrors[field] ? errorId : undefined}
                      onChange={(event) => updateDraft(field, event.target.value)}
                    />
                    {immutableId && <small>Host ID stays fixed so existing sessions keep their reference.</small>}
                    {!immutableId && hint && <small>{hint}</small>}
                    {draftErrors[field] && <small id={errorId} className="connections-field__error">{draftErrors[field]}</small>}
                  </label>
                );
              })}
            </div>

            {(selectedStatus || testedStatus) && (
              <div className="connections-runtime-status">
                <HostStateIcon status={testedStatus ?? selectedStatus} />
                <div>
                  <strong>{(testedStatus ?? selectedStatus)?.reachable ? "SSH reachable" : "SSH unavailable"}</strong>
                  <span>
                    {(testedStatus ?? selectedStatus)?.reachable
                      ? (testedStatus ?? selectedStatus)?.tmuxAvailable === false
                        ? (testedStatus ?? selectedStatus)?.tmuxError || "tmux is not available"
                        : !(testedStatus ?? selectedStatus)?.twAvailable
                          ? (testedStatus ?? selectedStatus)?.twError || "tw is not installed"
                          : (testedStatus ?? selectedStatus)?.twCompatible === false
                            ? `tw ${(testedStatus ?? selectedStatus)?.twVersion ?? "installed"} · RPC incompatible`
                            : `${(testedStatus ?? selectedStatus)?.tmuxVersion ?? "tmux ready"} · tw ${(testedStatus ?? selectedStatus)?.twVersion ?? "installed"}`
                      : (testedStatus ?? selectedStatus)?.error || "Run a connection test for details"}
                  </span>
                </div>
                {mode !== "add" && selectedStatus?.reachable && (!selectedStatus.twAvailable || selectedStatus.twCompatible === false) && selectedHost && (
                  <button
                    type="button"
                    className="connections-button"
                    disabled={hostBusy || installingHostId === selectedHost.id}
                    onClick={installTw}
                  >
                    {installingHostId === selectedHost.id
                      ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                      : <Download aria-hidden="true" size={14} />}
                    {installingHostId === selectedHost.id
                      ? "Installing"
                      : selectedStatus.twAvailable
                        ? "Upgrade tw"
                        : "Install tw"}
                  </button>
                )}
              </div>
            )}

            {hostNotice && (
              <div className={`connections-notice connections-notice--${hostNotice.tone}`} role="status" aria-live="polite">
                {statusIcon(hostNotice.tone)}
                <span>{hostNotice.message}</span>
              </div>
            )}

            {deleteConfirmationOpen && selectedHost && (
              <div className="connections-delete-confirm" role="alert">
                <AlertCircle aria-hidden="true" size={17} />
                <div>
                  <strong>Remove {selectedHost.label}?</strong>
                  <p>
                    This host is referenced by {hostImpact.sessions} remote {hostImpact.sessions === 1 ? "session" : "sessions"} and {hostImpact.terminals} remote {hostImpact.terminals === 1 ? "terminal" : "terminals"}. Removing it will not stop those remote processes, but the dashboard can no longer reconnect to them.
                  </p>
                  <div className="connections-delete-confirm__actions">
                    <button type="button" className="connections-button" disabled={hostBusy} onClick={() => setDeleteConfirmationOpen(false)}>
                      Keep host
                    </button>
                    <button type="button" className="connections-button connections-button--danger" disabled={hostBusy} onClick={deleteHost}>
                      <Trash2 aria-hidden="true" size={14} />
                      Remove host
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="connections-actions">
              {mode === "view" ? (
                <>
                  {selectedHost && (
                    <button
                      type="button"
                      className="connections-button connections-button--danger-quiet"
                      disabled={hostBusy}
                      onClick={() => setDeleteConfirmationOpen(true)}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      Delete
                    </button>
                  )}
                  <span className="connections-actions__spacer" />
                  {selectedHost && (
                    <button type="button" className="connections-button" disabled={hostBusy} onClick={testConnection}>
                      <PlugZap aria-hidden="true" size={14} />
                      Test
                    </button>
                  )}
                </>
              ) : (
                <button type="button" className="connections-button" disabled={hostBusy} onClick={cancelEdit}>
                  <X aria-hidden="true" size={14} />
                  Cancel
                </button>
              )}
              {mode !== "view" && <span className="connections-actions__spacer" />}
              {mode !== "view" && (
                <>
                  <button type="button" className="connections-button" disabled={hostBusy} onClick={testConnection}>
                    <PlugZap aria-hidden="true" size={14} />
                    Test
                  </button>
                  <button type="submit" className="connections-button connections-button--primary" disabled={hostBusy}>
                    <Save aria-hidden="true" size={14} />
                    {mode === "add" ? "Add host" : "Save changes"}
                  </button>
                </>
              )}
            </div>
          </form>
        </div>
      ) : (
        <div
          id="connections-active-panel"
          className="connections-panel"
          role="tabpanel"
          aria-labelledby="connections-tab-relay"
        >
          <div className="connections-heading-row">
            <div>
              <h3>Mobile Relay v2</h3>
              <p>Connect the Mac Host, then enroll the phone through the v2 one-time QR.</p>
            </div>
          </div>

          <RelayConnectionOverviewCard
            overview={relayOverview.overview}
            activeReview={relayOverview.activeReview}
            connectedMobileDevices={relayOverview.connectedMobileDevices}
            revokingGrantId={relayOverview.revokingGrantId}
            mobileDeviceObservationAvailable={relayOverview.mobileDeviceObservationAvailable}
            qrBusy={relayOverview.qrBusy}
            copiedEnrollmentLink={copiedEnrollmentLink}
            inlineQr={relayOverview.inlineQr}
            onPrimaryAction={handleRelayOverviewPrimaryAction}
            onCopyEnrollmentLink={handleCopyEnrollmentLink}
            onRevokeClientGrant={handleRevokeClientGrant}
            onHidePairingQr={relayOverview.hidePairingQr}
          />

          <details
            className="connections-relay-manual connections-relay-advanced"
            open={relayAdvancedOpen}
            onToggle={(event) => setRelayAdvancedOpen(event.currentTarget.open)}
          >
            <summary>
              <span className="connections-relay-manual__icon">
                <Settings2 aria-hidden="true" size={16} />
              </span>
              <span>
                <strong>Advanced</strong>
                <small>
                  Relay center status, deployment, and manual pairing controls. Collapsed by default.
                </small>
              </span>
            </summary>
            <div className="connections-relay-advanced__body">
              <div
                className={`connections-relay-summary connections-relay-stack connections-relay-stack--${relayV2Effective ? "v2" : "v1"}`}
                role="status"
              >
                {relayV2Effective
                  ? <Radio aria-hidden="true" size={18} />
                  : <Server aria-hidden="true" size={18} />}
                <div>
                  <strong>Current stack · {relayStackLabel}{relayV2Effective ? " · primary" : ""}</strong>
                  <span>
                    {relayV2Effective
                      ? relayV2ConnectorDesired
                        ? "Relay v2 self-hosted is the primary orchestration and the Host connector is desired to run."
                        : "Relay v2 self-hosted is the primary orchestration; the Host connector is not requested right now."
                      : "No enabled and provisioned self-hosted Relay v2 config. Complete v2 setup before pairing."}
                  </span>
                </div>
              </div>

              <RelayV2SelfHostedPanel hosts={hosts} />

              {relayV2Controller.loaded && (
                <RelayV2EnrollmentPreviewPanel
                  state={relayV2Controller.state}
                  onBootstrapHost={relayV2Controller.bootstrapHost}
                  onRefreshHost={relayV2Controller.refreshHost}
                  onStartConnector={relayV2Controller.startConnector}
                  onStopConnector={relayV2Controller.stopConnector}
                  onCreateEnrollment={relayV2Controller.createEnrollment}
                  onShowEnrollmentArtifact={relayV2Controller.showEnrollmentArtifact}
                  onCopyEnrollmentArtifact={relayV2Controller.copyEnrollmentArtifact}
                  artifactNotice={relayV2Controller.artifactNotice}
                />
              )}
            </div>
          </details>

        </div>
      )}
    </div>
  );
}
