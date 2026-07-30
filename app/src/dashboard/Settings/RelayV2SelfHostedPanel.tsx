import { Check, FolderOpen, LoaderCircle, Play, Save, Server, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MenuSelect, type MenuOption } from "../../MenuSelect";
import type {
  HostConfig,
  MobileRelayV2SelfHostedStatus,
} from "../../platform";
import { useDashboardBackend } from "../../platform";
import {
  createRelayV2SelfHostedDraft,
  relayV2SelfHostedDraftMatchesStatus,
  relayV2SelfHostedStatusLabel,
  selfHostedStatusToDraft,
  validateRelayV2SelfHostedDraft,
  type RelayV2SelfHostedDraft,
  type RelayV2SelfHostedDraftErrors,
} from "./relayV2SelfHostedModel";

type Operation = "save" | "deploy" | "start" | "stop" | null;

export function RelayV2SelfHostedPanel({ hosts }: { hosts: readonly HostConfig[] }) {
  const backend = useDashboardBackend();
  const [draft, setDraft] = useState<RelayV2SelfHostedDraft>(
    createRelayV2SelfHostedDraft,
  );
  const [status, setStatus] = useState<MobileRelayV2SelfHostedStatus | null>(null);
  const [errors, setErrors] = useState<RelayV2SelfHostedDraftErrors>({});
  const [operation, setOperation] = useState<Operation>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hostOptions = useMemo<MenuOption[]>(() => [
    { value: "", label: "Choose a devbox…" },
    ...hosts.map((host) => ({
      value: host.id,
      label: host.label || host.id,
      detail: host.host,
    })),
  ], [hosts]);

  useEffect(() => {
    let active = true;
    void backend.relay.v2Deployment.status().then((next) => {
      if (!active) return;
      setStatus(next);
      setDraft(selfHostedStatusToDraft(next));
    }).catch((error: unknown) => {
      if (active) setNotice(error instanceof Error ? error.message : String(error));
    });
    return () => {
      active = false;
    };
  }, [backend]);

  const update = <K extends keyof RelayV2SelfHostedDraft>(
    field: K,
    value: RelayV2SelfHostedDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(null);
  };

  const run = async (kind: Exclude<Operation, null>) => {
    if (operation) return;
    setNotice(null);
    setOperation(kind);
    try {
      let next: MobileRelayV2SelfHostedStatus;
      if (kind === "stop") {
        next = await backend.relay.v2Deployment.stopCenter();
      } else {
        const validation = validateRelayV2SelfHostedDraft(draft);
        setErrors(validation.errors);
        if (!validation.valid) {
          setNotice("Review the highlighted Relay v2 deployment fields.");
          return;
        }
        next = kind === "save"
          ? await backend.relay.v2Deployment.saveConfig(validation.value)
          : kind === "deploy"
            ? await backend.relay.v2Deployment.deploy(validation.value)
            : await backend.relay.v2Deployment.startCenter(validation.value);
      }
      setStatus(next);
      setDraft(selfHostedStatusToDraft(next));
      setNotice(kind === "save"
        ? "Self-hosted Relay v2 settings saved."
        : kind === "deploy"
          ? "Canonical tw bundle, TLS files, and deployment profile published."
          : kind === "start"
            ? "Relay v2 Center started on the selected devbox."
            : "Relay v2 Center stopped; persisted broker state was preserved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setOperation(null);
    }
  };

  const selectFile = async (
    field: "tlsKeyPath" | "tlsCertificatePath" | "tlsCaPath",
  ) => {
    const selected = await backend.dialog.selectFile({
      title: field === "tlsKeyPath"
        ? "Choose Relay v2 TLS private key"
        : field === "tlsCertificatePath"
          ? "Choose Relay v2 TLS leaf certificate"
          : "Choose Relay v2 TLS CA certificate",
    });
    if (selected) update(field, selected);
  };

  const locked = operation !== null;
  const running = status?.centerStatus === "running";
  const draftMatchesSaved = relayV2SelfHostedDraftMatchesStatus(draft, status);
  return (
    <section
      className="connections-relay-v2-deployment"
      aria-label="Relay v2 self-hosted deployment"
    >
      <div className="connections-card__header">
        <div>
          <h4>Relay v2 · self-hosted</h4>
          <p>
            Explicit feature: deploy the complete canonical tw bundle to one SSH devbox.
            Relay v1 tokens are neither read nor changed.
          </p>
        </div>
        <strong className="connections-relay-v2-deployment__status">
          {relayV2SelfHostedStatusLabel(status)}
        </strong>
      </div>

      <label className="connections-relay-v2-deployment__toggle">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={locked || running}
          onChange={(event) => update("enabled", event.target.checked)}
        />
        Enable explicit self-hosted Relay v2 configuration
      </label>
      {errors.enabled && <small className="connections-field__error">{errors.enabled}</small>}

      <div className="connections-fields connections-fields--relay-v2-deployment">
        <label className={`connections-field connections-field--wide${errors.brokerHostId ? " connections-field--error" : ""}`}>
          <span>SSH devbox</span>
          <MenuSelect
            id="relay-v2-self-hosted-devbox"
            ariaLabel="Relay v2 SSH devbox"
            className="connections-menu-select"
            value={draft.brokerHostId}
            options={hostOptions}
            disabled={locked || running || !draft.enabled}
            onChange={(value) => update("brokerHostId", value)}
          />
          {errors.brokerHostId && <small className="connections-field__error">{errors.brokerHostId}</small>}
        </label>
        <DeploymentField
          label="HTTPS Relay URL"
          value={draft.issuerUrl}
          placeholder="https://your-relay-hostname"
          error={errors.issuerUrl}
          disabled={locked || running || !draft.enabled}
          onChange={(value) => update("issuerUrl", value)}
        />
        <DeploymentField
          label="Devbox private IPv4"
          value={draft.listenHost}
          placeholder="10.x.x.x"
          error={errors.listenHost}
          disabled={locked || running || !draft.enabled}
          onChange={(value) => update("listenHost", value)}
        />
        <DeploymentField
          label="Bind port"
          value={draft.listenPort}
          placeholder="8788"
          error={errors.listenPort}
          disabled={locked || running || !draft.enabled}
          onChange={(value) => update("listenPort", value)}
        />
        <DeploymentFileField
          label="Local TLS private key"
          value={draft.tlsKeyPath}
          error={errors.tlsKeyPath}
          disabled={locked || running || !draft.enabled}
          onChoose={() => void selectFile("tlsKeyPath")}
        />
        <DeploymentFileField
          label="Local TLS leaf certificate"
          value={draft.tlsCertificatePath}
          error={errors.tlsCertificatePath}
          disabled={locked || running || !draft.enabled}
          onChoose={() => void selectFile("tlsCertificatePath")}
        />
        <DeploymentFileField
          label="Local TLS CA certificate"
          value={draft.tlsCaPath}
          error={errors.tlsCaPath}
          disabled={locked || running || !draft.enabled}
          onChoose={() => void selectFile("tlsCaPath")}
        />
      </div>

      {status?.configured && (
        <div className="connections-relay-v2-deployment__facts">
          <span>Bundle · {status.bundleStatus}</span>
          <span>TLS/profile · {status.tlsStatus}</span>
          <span>Center · {status.centerStatus}</span>
          <span>Host bootstrap · {status.hostBootstrapAvailable ? "0600 file ready" : "not created"}</span>
        </div>
      )}
      <p className="connections-relay-v2-deployment__hint">
        Enter the devbox&apos;s private IPv4 explicitly. Using 0.0.0.0 is an
        explicit opt-in to listen on every interface.{" "}
        TLS key, leaf certificate, and CA certificate must be current-user-owned,
        single-link, exact 0600 files. Deployment publishes separate 0600 copies and
        keeps the Broker SQLite state directory 0700.
      </p>
      {(notice || status?.error) && (
        <div className="connections-notice connections-notice--pending" role="status">
          <span>{notice || status?.error}</span>
        </div>
      )}
      <div className="connections-actions connections-actions--relay">
        <button
          type="button"
          className="connections-button"
          disabled={locked || running}
          onClick={() => void run("save")}
        >
          {operation === "save" ? <LoaderCircle className="connections-spin" size={14} /> : <Save size={14} />}
          Save v2 settings
        </button>
        <button
          type="button"
          className="connections-button"
          disabled={locked || running}
          onClick={() => void run("deploy")}
        >
          {operation === "deploy" ? <LoaderCircle className="connections-spin" size={14} /> : <Server size={14} />}
          Deploy / update bundle
        </button>
        {running ? (
          <button
            type="button"
            className="connections-button connections-button--danger"
            disabled={locked}
            onClick={() => void run("stop")}
          >
            {operation === "stop" ? <LoaderCircle className="connections-spin" size={14} /> : <Square size={14} />}
            Stop v2 Relay Center
          </button>
        ) : (
          <button
            type="button"
            className="connections-button connections-button--primary"
            disabled={locked
              || !draftMatchesSaved
              || status?.bundleStatus !== "ready"
              || status?.tlsStatus !== "ready"}
            onClick={() => void run("start")}
          >
            {operation === "start" ? <LoaderCircle className="connections-spin" size={14} /> : <Play size={14} />}
            Start v2 Relay Center
          </button>
        )}
      </div>
    </section>
  );
}

function DeploymentField({
  label,
  value,
  placeholder,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className={`connections-field${error ? " connections-field--error" : ""}`}>
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <small className="connections-field__error">{error}</small>}
    </label>
  );
}

function DeploymentFileField({
  label,
  value,
  error,
  disabled,
  onChoose,
}: {
  label: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <label className={`connections-field connections-field--wide${error ? " connections-field--error" : ""}`}>
      <span>{label}</span>
      <span className="connections-copy-field">
        <input value={value} readOnly placeholder="Choose a local 0600 file" />
        <button
          type="button"
          className="connections-icon-button"
          disabled={disabled}
          aria-label={`Choose ${label}`}
          onClick={onChoose}
        >
          {value ? <Check size={15} /> : <FolderOpen size={15} />}
        </button>
      </span>
      {error && <small className="connections-field__error">{error}</small>}
    </label>
  );
}
