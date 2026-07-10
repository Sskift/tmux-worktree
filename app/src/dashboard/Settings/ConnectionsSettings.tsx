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
  Radio,
  RotateCcw,
  Save,
  Server,
  Square,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { MenuSelect, type MenuOption } from "../../MenuSelect";
import type { HostConfig, HostStatus, PlainTerminal, Session } from "../../platform";
import { useDashboardBackend } from "../../platform";
import type { MobileRelayController } from "../hooks/useMobileRelayController";
import "../design/tokens.css";
import "./ConnectionsSettings.css";
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
  connectionState: RelayConnectionState;
  active: boolean;
  connected: boolean;
  tokenConfigured: boolean;
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
  sshHostCandidates: readonly HostConfig[];
  sessions: readonly Session[];
  terminals: readonly PlainTerminal[];
  onHostsChange: (hosts: HostConfig[]) => void;
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
      relayUrl: controller.draftUrl,
      brokerHostId: controller.brokerHostId,
      hostId: controller.draftHostId,
      token: controller.draftSecret,
      tokenConfigured: controller.tokenState === "Configured",
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
  sshHostCandidates,
  sessions,
  terminals,
  onHostsChange,
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
        { value: "", label: "Choose a broker…" },
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
  const relayBusy = Object.values(relay.busy).some(Boolean);
  const hostBusy = hostNotice?.tone === "pending";

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (mode === "add") return;
    const current = hosts.find((host) => host.id === selectedHostId);
    if (current) {
      if (mode === "view") setDraft(hostConfigToDraft(current));
      return;
    }

    const nextHost = hosts[0] ?? null;
    setSelectedHostId(nextHost?.id ?? null);
    setDraft(nextHost ? hostConfigToDraft(nextHost) : createEmptyHostDraft());
    setMode(nextHost ? "view" : "add");
  }, [hosts, mode, selectedHostId]);

  const resetFeedback = () => {
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
    setDraft((current) => ({ ...current, [field]: value }));
    setDraftErrors((current) => ({ ...current, [field]: undefined }));
    setHostNotice(null);
    setTestedStatus(null);
  };

  const applyCandidate = () => {
    if (!selectedCandidate) return;
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

  const testConnection = async () => {
    const validation = validateCurrentHost(false);
    if (!validation.valid) return;

    setHostNotice({ tone: "pending", message: "Testing the SSH connection…" });
    setTestedStatus(null);
    try {
      const status = await dashboardBackend.hosts.test(validation.value);
      setTestedStatus(status);
      setHostNotice(status.reachable
        ? {
            tone: "success",
            message: `Connected${status.latencyMs === null ? "" : ` in ${status.latencyMs} ms`}.`,
          }
        : { tone: "error", message: status.error || "SSH connection failed." });
    } catch (error) {
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const saveHost = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "view") return;
    const validation = validateCurrentHost(true);
    if (!validation.valid) return;

    setHostNotice({
      tone: "pending",
      message: mode === "add" ? "Adding host…" : "Saving host changes…",
    });
    try {
      const updatedHosts = mode === "add"
        ? await dashboardBackend.hosts.add(validation.value)
        : await dashboardBackend.hosts.update(validation.value);
      onHostsChange(updatedHosts);
      setSelectedHostId(validation.value.id);
      setDraft(hostConfigToDraft(validation.value));
      setMode("view");
      setDraftErrors({});
      setHostNotice({
        tone: "success",
        message: mode === "add" ? "Host added." : "Host changes saved.",
      });
    } catch (error) {
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const deleteHost = async () => {
    if (!selectedHost) return;
    setHostNotice({ tone: "pending", message: `Removing ${selectedHost.label}…` });
    try {
      const updatedHosts = await dashboardBackend.hosts.remove(selectedHost.id);
      onHostsChange(updatedHosts);
      const nextHost = updatedHosts[0] ?? null;
      setSelectedHostId(nextHost?.id ?? null);
      setDraft(nextHost ? hostConfigToDraft(nextHost) : createEmptyHostDraft());
      setMode(nextHost ? "view" : "add");
      setDeleteConfirmationOpen(false);
      setHostNotice({ tone: "success", message: `${selectedHost.label} was removed.` });
    } catch (error) {
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const installTw = async () => {
    if (!selectedHost) return;
    setHostNotice({ tone: "pending", message: `Installing tw on ${selectedHost.label}…` });
    try {
      await onInstallTw(selectedHost.id);
      setHostNotice({ tone: "success", message: "tw installation finished. Status will refresh shortly." });
    } catch (error) {
      setHostNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const runRelayAction = async (
    intent: "save" | "start" | "startBroker" | "stop",
    action: () => RelayActionResult | Promise<RelayActionResult>,
  ) => {
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
      start: "Starting Relay…",
      startBroker: "Starting the broker…",
      stop: "Stopping Relay…",
    };
    const successLabel: Record<typeof intent, string> = {
      save: "Relay configuration saved.",
      start: "Relay start requested.",
      startBroker: "Broker start requested.",
      stop: "Relay stopped.",
    };

    setRelayNotice({ tone: "pending", message: pendingLabel[intent] });
    try {
      const completed = await action();
      if (completed === false) {
        setRelayNotice({
          tone: "error",
          message: "Relay action did not complete. Review the status above for details.",
        });
        return;
      }
      setRelayNotice({ tone: "success", message: successLabel[intent] });
    } catch (error) {
      setRelayNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  const copyRelayValue = async (field: RelayCopyField, value: string) => {
    if (!value) return;
    try {
      await relayActions.copy(field, value);
      setCopiedField(field);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedField(null), 1_200);
    } catch (error) {
      setRelayNotice({ tone: "error", message: errorMessage(error) });
    }
  };

  return (
    <div className="connections-settings">
      <div className="connections-tabs" role="tablist" aria-label="Connection settings">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "hosts"}
          className="connections-tabs__item"
          onClick={() => setActiveTab("hosts")}
        >
          <Server aria-hidden="true" size={15} />
          Hosts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "relay"}
          className="connections-tabs__item"
          onClick={() => setActiveTab("relay")}
        >
          <Radio aria-hidden="true" size={15} />
          Relay
        </button>
      </div>

      {activeTab === "hosts" ? (
        <div className="connections-panel" role="tabpanel">
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

          {hosts.length > 0 && (
            <div className="connections-host-list" role="list" aria-label="Configured SSH hosts">
              {hosts.map((host) => {
                const status = hostStatuses[host.id] ?? null;
                const selected = selectedHostId === host.id && mode !== "add";
                return (
                  <button
                    key={host.id}
                    type="button"
                    role="listitem"
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
                      ? (testedStatus ?? selectedStatus)?.twAvailable
                        ? `tw ${(testedStatus ?? selectedStatus)?.twVersion ?? "installed"}`
                        : (testedStatus ?? selectedStatus)?.twError || "tw is not installed"
                      : (testedStatus ?? selectedStatus)?.error || "Run a connection test for details"}
                  </span>
                </div>
                {mode !== "add" && selectedStatus?.reachable && !selectedStatus.twAvailable && selectedHost && (
                  <button
                    type="button"
                    className="connections-button"
                    disabled={hostBusy || installingHostId === selectedHost.id}
                    onClick={installTw}
                  >
                    {installingHostId === selectedHost.id
                      ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                      : <Download aria-hidden="true" size={14} />}
                    {installingHostId === selectedHost.id ? "Installing" : "Install tw"}
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
        <div className="connections-panel" role="tabpanel">
          <div className="connections-heading-row">
            <div>
              <h3>Mobile Relay</h3>
              <p>Connect the mobile client without exposing the local dashboard.</p>
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

          <div className="connections-card connections-relay-card">
            <div className="connections-card__header">
              <div>
                <h4>Relay configuration</h4>
                <p>Credentials stay masked. Copying always requires a button press.</p>
              </div>
            </div>

            <div className="connections-fields connections-fields--relay">
              <div className={`connections-field connections-field--wide${relayErrors.brokerHostId ? " connections-field--error" : ""}`}>
                <span>Broker</span>
                <MenuSelect
                  ariaLabel="Relay broker"
                  className="connections-menu-select"
                  value={relay.brokerHostId}
                  options={brokerOptions}
                  disabled={relayBusy || relay.active || hosts.length === 0}
                  onChange={(value) => {
                    relayActions.setBrokerHostId(value);
                    setRelayErrors((current) => ({ ...current, brokerHostId: undefined }));
                  }}
                />
                {relayErrors.brokerHostId && <small className="connections-field__error">{relayErrors.brokerHostId}</small>}
              </div>

              <RelayField
                id="connection-relay-url"
                label="Relay URL"
                value={relay.relayUrl}
                placeholder="wss://relay.example.com"
                error={relayErrors.relayUrl}
                disabled={relayBusy || relay.active}
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
                disabled={relayBusy || relay.active}
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
                disabled={relayBusy || relay.active}
                copied={copiedField === "token"}
                secret
                onChange={(value) => {
                  relayActions.setToken(value);
                  setRelayErrors((current) => ({ ...current, token: undefined }));
                }}
                onCopy={() => copyRelayValue("token", relay.token)}
              />
            </div>

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

            <div className="connections-actions connections-actions--relay">
              {relay.active ? (
                <button
                  type="button"
                  className="connections-button connections-button--danger"
                  disabled={relayBusy}
                  onClick={() => runRelayAction("stop", relayActions.stop)}
                >
                  {relay.busy.stop
                    ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                    : <Square aria-hidden="true" size={14} />}
                  {relay.busy.stop ? "Stopping" : "Stop"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="connections-button"
                    disabled={relayBusy || !hosts.length}
                    onClick={() => runRelayAction("startBroker", relayActions.startBroker)}
                  >
                    {relay.busy.startBroker
                      ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                      : <Server aria-hidden="true" size={14} />}
                    {relay.busy.startBroker ? "Starting broker" : "Start broker"}
                  </button>
                  <span className="connections-actions__spacer" />
                  <button
                    type="button"
                    className="connections-button"
                    disabled={relayBusy}
                    onClick={() => runRelayAction("save", relayActions.save)}
                  >
                    {relay.busy.save
                      ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                      : <Save aria-hidden="true" size={14} />}
                    {relay.busy.save ? "Saving" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="connections-button connections-button--primary"
                    disabled={relayBusy}
                    onClick={() => runRelayAction("start", relayActions.start)}
                  >
                    {relay.busy.start
                      ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                      : <Play aria-hidden="true" size={14} />}
                    {relay.busy.start ? "Starting" : "Start"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RelayFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled: boolean;
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
  copied,
  secret = false,
  onChange,
  onCopy,
}: RelayFieldProps) {
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
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="connections-icon-button"
          disabled={!value}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          onClick={onCopy}
        >
          {copied ? <Check aria-hidden="true" size={15} /> : <Clipboard aria-hidden="true" size={15} />}
        </button>
      </span>
      {error && <small className="connections-field__error">{error}</small>}
    </label>
  );
}
