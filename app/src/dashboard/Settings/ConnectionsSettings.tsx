import {
  AlertCircle,
  Check,
  Clipboard,
  Download,
  LoaderCircle,
  Pencil,
  Play,
  PlugZap,
  Plus,
  QrCode,
  Radio,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Square,
  Trash2,
  Wifi,
  WifiOff,
  Wrench,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import QRCode from "qrcode";
import { MenuSelect, type MenuOption } from "../../MenuSelect";
import type {
  HostConfig,
  HostStatus,
  MobileRelayV2SelfHostedStatus,
  PlainTerminal,
  Session,
} from "../../platform";
import { useDashboardBackend } from "../../platform";
import type { MobileRelayController } from "../hooks/useMobileRelayController";
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
  summarizeRelayStatus,
  validateHostDraft,
  validateRelayDraft,
  type HostDraft,
  type HostDraftErrors,
  type HostDraftField,
  type RelayConnectionState,
  type RelayDraft,
  type RelayDraftErrors,
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

export type RelayCopyField = "relayUrl" | "hostId" | "token";
export type RelayBusyAction = "save" | "start" | "startBroker" | "stop";
export type RelayActionResult = boolean | void;

export interface RelaySettingsBusyState {
  save: boolean;
  start: boolean;
  startBroker: boolean;
  stop: boolean;
}

export interface RelaySettingsModel extends RelayDraft {
  statusKnown: boolean;
  connectionState: RelayConnectionState;
  active: boolean;
  connected: boolean;
  tokenConfigured: boolean;
  v1PairingPayload: string | null;
  error?: string | null;
  busy: RelaySettingsBusyState;
}

export interface RelaySettingsActions {
  setRelayUrl: (value: string) => void;
  setBrokerHostId: (value: string) => void;
  setHostId: (value: string) => void;
  setToken: (value: string) => void;
  save: () => RelayActionResult | Promise<RelayActionResult>;
  start: () => RelayActionResult | Promise<RelayActionResult>;
  startBroker: () => RelayActionResult | Promise<RelayActionResult>;
  stop: () => RelayActionResult | Promise<RelayActionResult>;
  copy: (field: RelayCopyField, value: string) => void | Promise<void>;
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
  relay: RelaySettingsModel;
  relayActions: RelaySettingsActions;
}

export interface RelaySettingsBindings {
  relay: RelaySettingsModel;
  relayActions: RelaySettingsActions;
}

export function relaySettingsBindingsFromController(
  controller: MobileRelayController,
): RelaySettingsBindings {
  const connectionState: RelayConnectionState = controller.error
    ? "error"
    : controller.connected
      ? "connected"
      : controller.connectionState === "retrying"
        ? "retrying"
        : controller.active || controller.busy
          ? "starting"
          : "stopped";

  return {
    relay: {
      statusKnown: controller.statusKnown,
      relayUrl: controller.draftUrl,
      brokerHostId: controller.brokerHostId,
      hostId: controller.draftHostId,
      token: controller.draftSecret,
      tokenConfigured: controller.tokenState === "Configured",
      v1PairingPayload: controller.v1PairingPayload,
      connectionState,
      active: controller.active,
      connected: controller.connected,
      error: controller.error,
      busy: {
        save: controller.saving,
        start: controller.loading,
        startBroker: controller.brokerStarting,
        stop: controller.stopping,
      },
    },
    relayActions: {
      setRelayUrl: controller.setDraftUrl,
      setBrokerHostId: controller.setBrokerHostId,
      setHostId: controller.setDraftHostId,
      setToken: controller.setDraftSecret,
      save: controller.save,
      start: controller.start,
      startBroker: controller.startBroker,
      stop: controller.stop,
      copy: (_field, value) => controller.copyValue(value),
    },
  };
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

const EMPTY_RELAY_ERRORS: RelayDraftErrors = {};
const RELAY_BROKER_ID = "connection-relay-broker";
const RELAY_BROKER_ERROR_ID = `${RELAY_BROKER_ID}-error`;

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
  relay,
  relayActions,
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
  const [relayErrors, setRelayErrors] = useState<RelayDraftErrors>(EMPTY_RELAY_ERRORS);
  const [relayNotice, setRelayNotice] = useState<AsyncNotice | null>(null);
  const [copiedField, setCopiedField] = useState<RelayCopyField | null>(null);
  const copyTimerRef = useRef<number | null>(null);
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
  const brokerOptions = useMemo<MenuOption[]>(() => hosts.length
    ? [
        { value: "", label: "Choose a Relay center…" },
        ...hosts.map((host) => ({
          value: host.id,
          label: host.label || host.id,
          detail: host.host,
        })),
      ]
    : [{ value: "", label: "No SSH hosts configured" }], [hosts]);
  const hostImpact = useMemo(
    () => calculateHostRemovalImpact(selectedHostId ?? "", sessions, terminals),
    [selectedHostId, sessions, terminals],
  );
  const relaySummary = summarizeRelayStatus(relay);
  const relayV2Effective = relayV2StackEffective(relayV2Status);
  const relayStackLabel = relayV2SelfHostedStackLabel(relayV2Status);
  const relayV2ConnectorDesired = relayV2SelfHostedConnectorDesiredRunning(relayV2Status);
  const selectedRelayCenter = hosts.find((host) => host.id === relay.brokerHostId) ?? null;
  const relayBusy = Object.values(relay.busy).some(Boolean);
  const relayDraftLocked = relayBusy || relay.active || !relay.statusKnown;
  const relayActionLocked = relayBusy || !relay.statusKnown;
  const hostBusy = hostNotice?.tone === "pending";

  useEffect(() => () => {
    asyncCoordinatorRef.current.invalidateAll();
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

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

  // One shared Relay v2 management controller drives both the overview card and
  // the Advanced enrollment panel, so both stay in sync on the same polled state.
  const relayV2Controller = useRelayV2EnrollmentController(relay.tokenConfigured);
  const relayOverview = useRelayConnectionOverview(relayV2Status, relayV2Controller);

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

  const runRelayAction = async (
    intent: "save" | "start" | "startBroker" | "stop",
    action: () => RelayActionResult | Promise<RelayActionResult>,
  ) => {
    if (intent !== "stop" && !relay.statusKnown) {
      setRelayErrors({});
      setRelayNotice({
        tone: "error",
        message: "Wait for Relay status before changing its configuration.",
      });
      return;
    }
    const request = asyncCoordinatorRef.current.issue(
      "relay",
      intent,
      relay.relayUrl,
      relay.brokerHostId,
      relay.hostId,
      relay.token,
    );
    if (intent !== "stop") {
      const validation = validateRelayDraft(relay, intent);
      setRelayErrors(validation.errors);
      if (!validation.valid) {
        setRelayNotice({ tone: "error", message: "Review the highlighted Relay fields." });
        return;
      }
    } else {
      setRelayErrors({});
    }

    const pendingLabel: Record<typeof intent, string> = {
      save: "Saving Relay configuration…",
      start: "Connecting this Mac to the saved Relay…",
      startBroker: "Setting up broker, trusted WSS, and the Mac connector…",
      stop: "Disconnecting this Mac from the Relay…",
    };
    const successLabel: Record<typeof intent, string> = {
      save: "Relay configuration saved.",
      start: "This Mac is connecting to the saved Relay. The connector retries while DNS propagates.",
      startBroker: "Relay setup started. The broker and tunnel stay available while the Mac connector retries DNS. The QR appears after it reaches the generated WSS endpoint. Existing Android pairing must be updated after token rotation.",
      stop: "This Mac disconnected. The selected Relay center keeps running.",
    };

    setRelayNotice({ tone: "pending", message: pendingLabel[intent] });
    try {
      const completed = await action();
      if (!asyncCoordinatorRef.current.isCurrent(request)) return;
      if (completed === false) {
        setRelayNotice({
          tone: "error",
          message: "Relay action did not complete. Review the status above for details.",
        });
        return;
      }
      setRelayNotice({ tone: "success", message: successLabel[intent] });
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(request)) return;
      setRelayNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const copyRelayValue = async (field: RelayCopyField, value: string) => {
    if (!value) return;
    const request = asyncCoordinatorRef.current.issue("relay", "copy", field, value);
    setRelayNotice(null);
    try {
      await relayActions.copy(field, value);
      if (!asyncCoordinatorRef.current.isCurrent(request)) return;
      setCopiedField(field);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedField(null), 1_200);
    } catch (error) {
      if (!asyncCoordinatorRef.current.isCurrent(request)) return;
      setRelayNotice({ tone: "error", message: errorMessage(error) });
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

  const handleRevokeKnownGrant = () => {
    relayOverview.revokeKnownGrant();
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

  // Relay v1 blocks are kept intact and re-composed: as the default layout when
  // Relay v2 is not effective, and collapsed under a "Legacy Relay v1" entry
  // when Relay v2 self-hosted is the primary stack.
  const relayV1CenterField = (
    <div className="connections-fields connections-fields--relay">
      <div className={`connections-field connections-field--wide${relayErrors.brokerHostId ? " connections-field--error" : ""}`}>
        <span>Relay center</span>
        <MenuSelect
          id={RELAY_BROKER_ID}
          ariaLabel="Relay center"
          ariaInvalid={Boolean(relayErrors.brokerHostId)}
          ariaDescribedBy={relayErrors.brokerHostId ? RELAY_BROKER_ERROR_ID : undefined}
          ariaErrorMessage={relayErrors.brokerHostId ? RELAY_BROKER_ERROR_ID : undefined}
          className="connections-menu-select"
          value={relay.brokerHostId}
          options={brokerOptions}
          disabled={relayDraftLocked || hosts.length === 0}
          onChange={(value) => {
            relayActions.setBrokerHostId(value);
            setRelayErrors((current) => ({ ...current, brokerHostId: undefined }));
          }}
        />
        {relayErrors.brokerHostId && (
          <small id={RELAY_BROKER_ERROR_ID} className="connections-field__error">
            {relayErrors.brokerHostId}
          </small>
        )}
        {!relayErrors.brokerHostId && (
          <small>Saved with this connection. Set up Relay deploys only to this SSH host and rotates the v1 token.</small>
        )}
      </div>
    </div>
  );

  const relayV1ManualRecovery = (
    <details className="connections-relay-manual">
      <summary>
        <span className="connections-relay-manual__icon">
          <Wrench aria-hidden="true" size={16} />
        </span>
        <span>
          <strong>Manual recovery</strong>
          <small>Inspect or supply a fixed WSS profile. These controls do not create a Relay center.</small>
        </span>
      </summary>
      <div className="connections-fields connections-fields--relay connections-relay-manual__fields">
        <RelayField
          id="connection-relay-url"
          label="Relay URL"
          value={relay.relayUrl}
          placeholder="Enter the trusted wss:// endpoint for this Relay center"
          error={relayErrors.relayUrl}
          disabled={relayDraftLocked}
          copyDisabled={!relay.statusKnown}
          copied={copiedField === "relayUrl"}
          onChange={(value) => {
            relayActions.setRelayUrl(value);
            setRelayErrors((current) => ({ ...current, relayUrl: undefined }));
          }}
          onCopy={() => copyRelayValue("relayUrl", relay.relayUrl)}
        />
        <RelayField
          id="connection-relay-host"
          label="Host ID"
          value={relay.hostId}
          placeholder="mac-admin"
          error={relayErrors.hostId}
          disabled={relayDraftLocked}
          copyDisabled={!relay.statusKnown}
          copied={copiedField === "hostId"}
          onChange={(value) => {
            relayActions.setHostId(value);
            setRelayErrors((current) => ({ ...current, hostId: undefined }));
          }}
          onCopy={() => copyRelayValue("hostId", relay.hostId)}
        />
        <RelayField
          id="connection-relay-token"
          label="Token"
          value={relay.token}
          placeholder={relay.tokenConfigured ? "Configured" : "Required to start Relay"}
          error={relayErrors.token}
          disabled={relayDraftLocked}
          copyDisabled={!relay.statusKnown}
          copied={copiedField === "token"}
          secret
          onChange={(value) => {
            relayActions.setToken(value);
            setRelayErrors((current) => ({ ...current, token: undefined }));
          }}
          onCopy={() => copyRelayValue("token", relay.token)}
        />
      </div>
      {!relay.active && (
        <div className="connections-actions connections-actions--relay-manual">
          <span className="connections-actions__spacer" />
          <button
            type="button"
            className="connections-button"
            disabled={relayActionLocked}
            title="Save these fields without starting any local or remote process"
            onClick={() => runRelayAction("save", relayActions.save)}
          >
            {relay.busy.save
              ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
              : <Save aria-hidden="true" size={14} />}
            {relay.busy.save ? "Saving fields" : "Save fields only"}
          </button>
          <button
            type="button"
            className="connections-button"
            disabled={relayActionLocked}
            title="Connect this Mac to an already running Relay using the saved fields"
            onClick={() => runRelayAction("start", relayActions.start)}
          >
            {relay.busy.start
              ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
              : <Play aria-hidden="true" size={14} />}
            {relay.busy.start ? "Connecting this Mac" : "Connect this Mac"}
          </button>
        </div>
      )}
    </details>
  );

  const relayV1Pairing = (
    <div className="connections-relay-pairing">
      <div className="connections-relay-pairing__copy">
        <span className="connections-relay-pairing__icon">
          <QrCode aria-hidden="true" size={17} />
        </span>
        <div>
          <strong>Relay v1 profile</strong>
          <span>
            {relay.v1PairingPayload
              ? "Contains the current shared Relay v1 token. Scan only on a trusted Android device and review before saving. This is not a Relay v2 capability."
              : relay.active && relay.tokenConfigured
                ? "Android pairing is unavailable until the connector reaches a trusted root wss:// URL with a valid Host ID. Cleartext and local URLs are never exported."
                : "Start the Mac connector with a trusted WSS configuration to create an Android profile."}
          </span>
        </div>
      </div>
      {relay.v1PairingPayload && (
        <MobileRelayV1ProfileQrCode payload={relay.v1PairingPayload} />
      )}
    </div>
  );

  const relayV1Actions = (
    <div className="connections-actions connections-actions--relay">
      <span className="connections-actions__spacer" />
      {relay.active ? (
        <button
          type="button"
          className="connections-button connections-button--danger"
          disabled={relayBusy}
          title="Disconnect this Mac only; the selected Relay center keeps running"
          onClick={() => runRelayAction("stop", relayActions.stop)}
        >
          {relay.busy.stop
            ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
            : <Square aria-hidden="true" size={14} />}
          {relay.busy.stop ? "Disconnecting this Mac" : "Disconnect this Mac"}
        </button>
      ) : (
        <button
          type="button"
          className="connections-button connections-button--primary"
          disabled={relayActionLocked || !hosts.length}
          title="Create or repair the broker, trusted WSS tunnel, token, and this Mac connector"
          onClick={() => runRelayAction("startBroker", relayActions.startBroker)}
        >
          {relay.busy.startBroker
            ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
            : <Server aria-hidden="true" size={14} />}
          {relay.busy.startBroker
            ? "Setting up Relay"
            : "Set up / repair Relay"}
        </button>
      )}
    </div>
  );

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
              <h3>Mobile Relay</h3>
              <p>Connect a relay center and pair your phone. Everything else lives under Advanced.</p>
            </div>
          </div>

          <RelayConnectionOverviewCard
            overview={relayOverview.overview}
            activeReview={relayOverview.activeReview}
            knownGrantActive={relayOverview.knownGrantActive}
            revokingGrant={relayOverview.revokingGrant}
            qrBusy={relayOverview.qrBusy}
            copiedEnrollmentLink={copiedEnrollmentLink}
            inlineQr={relayOverview.inlineQr}
            onPrimaryAction={handleRelayOverviewPrimaryAction}
            onCopyEnrollmentLink={handleCopyEnrollmentLink}
            onRevokeKnownGrant={handleRevokeKnownGrant}
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
                  <strong>Current stack · {relayStackLabel}{relayV2Effective ? " · primary" : " · default"}</strong>
                  <span>
                    {relayV2Effective
                      ? relayV2ConnectorDesired
                        ? "Relay v2 self-hosted is the primary orchestration and the Host connector is desired to run."
                        : "Relay v2 self-hosted is the primary orchestration; the Host connector is not requested right now."
                      : "No enabled and provisioned self-hosted Relay v2 config. Relay v1 remains the default stack."}
                  </span>
                </div>
              </div>

              <div className="connections-relay-stages" aria-label="Relay connection stages">
                <div className={`connections-relay-summary${relay.busy.startBroker ? " connections-relay-summary--progress" : ""}`}>
                  {relay.busy.startBroker
                    ? <LoaderCircle className="connections-spin" aria-hidden="true" size={18} />
                    : <Server aria-hidden="true" size={18} />}
                  <div>
                    <strong>Relay center · {selectedRelayCenter?.label || "Not selected"}</strong>
                    <span>
                      {relay.busy.startBroker
                        ? "Deploying Relay v1, publishing trusted WSS, and starting this Mac connector."
                        : "Set up / repair Relay reuses a fixed WSS URL, or provisions a temporary Cloudflare Quick Tunnel. DNS propagation is handled by connector retries."}
                    </span>
                  </div>
                </div>
                <div className={`connections-relay-summary connections-relay-summary--${relaySummary.tone}`}>
                  {relaySummary.tone === "success"
                    ? <Wifi aria-hidden="true" size={18} />
                    : relaySummary.tone === "danger"
                      ? <AlertCircle aria-hidden="true" size={18} />
                      : relaySummary.tone === "progress"
                        ? <LoaderCircle className="connections-spin" aria-hidden="true" size={18} />
                        : <Radio aria-hidden="true" size={18} />}
                  <div>
                    <strong>{relaySummary.label}</strong>
                    <span>{relaySummary.detail}</span>
                  </div>
                </div>
                <div className={`connections-relay-summary${relay.v1PairingPayload ? " connections-relay-summary--success" : ""}`}>
                  <QrCode aria-hidden="true" size={18} />
                  <div>
                    <strong>Android pairing · {relay.v1PairingPayload ? "Ready" : "Not ready"}</strong>
                    <span>
                      {relay.v1PairingPayload
                        ? "A trusted root wss:// profile is available. The phone still connects independently after review."
                        : "Requires a connected Mac connector, a trusted root wss:// URL, Host ID, and Relay v1 token."}
                    </span>
                  </div>
                </div>
              </div>

              <RelayV2SelfHostedPanel hosts={hosts} />

              {relayV2Controller.loaded && (
                <RelayV2EnrollmentPreviewPanel
                  state={relayV2Controller.state}
                  v1SharedSecretConfigured={relay.tokenConfigured}
                  onBootstrapHost={relayV2Controller.bootstrapHost}
                  onRefreshHost={relayV2Controller.refreshHost}
                  onStartConnector={relayV2Controller.startConnector}
                  onStopConnector={relayV2Controller.stopConnector}
                  onCreateEnrollment={relayV2Controller.createEnrollment}
                  onShowEnrollmentArtifact={relayV2Controller.showEnrollmentArtifact}
                  onCopyEnrollmentArtifact={relayV2Controller.copyEnrollmentArtifact}
                  artifactNotice={relayV2Controller.artifactNotice}
                  onRevokeKnownGrant={relayV2Controller.revokeKnownGrant}
                />
              )}
            </div>
          </details>

          {relayV2Effective ? (
            <details
              className="connections-relay-manual connections-relay-legacy-v1"
              open={false}
            >
              <summary>
                <span className="connections-relay-manual__icon">
                  <Wrench aria-hidden="true" size={16} />
                </span>
                <span>
                  <strong>Legacy Relay v1 (optional)</strong>
                  <small>
                    v1 broker setup, fixed WSS recovery, and the v1 Android profile
                    remain available as a legacy path.
                  </small>
                </span>
              </summary>
              {relayV1CenterField}
              {relayV1ManualRecovery}
              {relayV1Pairing}
              {relayV1Actions}
            </details>
          ) : (
            <>
              {relayV1CenterField}
              {relayV1ManualRecovery}
              {relayV1Pairing}
            </>
          )}

          {(relay.error || relayNotice) && (
            <div
              className={`connections-notice connections-notice--${relay.error ? "error" : relayNotice?.tone}`}
              role="status"
              aria-live="polite"
            >
              {statusIcon(relay.error ? "error" : relayNotice?.tone ?? "pending")}
              <span>{relay.error || relayNotice?.message}</span>
            </div>
          )}

          {!relayV2Effective && relayV1Actions}
        </div>
      )}
    </div>
  );
}

function MobileRelayV1ProfileQrCode({ payload }: { payload: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    void QRCode.toCanvas(canvas, payload, {
      width: 156,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#111113",
        light: "#ffffff",
      },
    }).catch(() => {
      if (!active) return;
      canvas.width = 0;
      canvas.height = 0;
    });
    return () => {
      active = false;
    };
  }, [payload]);

  return (
    <canvas
      ref={canvasRef}
      className="connections-relay-pairing__qr"
      aria-label="Android Relay v1 profile QR code"
      role="img"
    />
  );
}

interface RelayFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled: boolean;
  copyDisabled?: boolean;
  copied: boolean;
  secret?: boolean;
  onChange: (value: string) => void;
  onCopy: () => void;
}

function RelayField({
  id,
  label,
  value,
  placeholder,
  error,
  disabled,
  copyDisabled = false,
  copied,
  secret = false,
  onChange,
  onCopy,
}: RelayFieldProps) {
  const errorId = `${id}-error`;
  return (
    <label className={`connections-field connections-field--wide${error ? " connections-field--error" : ""}`} htmlFor={id}>
      <span>{label}</span>
      <span className="connections-copy-field">
        <input
          id={id}
          type={secret ? "password" : "text"}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          aria-errormessage={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="connections-icon-button"
          disabled={copyDisabled || !value}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          onClick={onCopy}
        >
          {copied ? <Check aria-hidden="true" size={15} /> : <Clipboard aria-hidden="true" size={15} />}
        </button>
      </span>
      {error && <small id={errorId} className="connections-field__error">{error}</small>}
    </label>
  );
}
