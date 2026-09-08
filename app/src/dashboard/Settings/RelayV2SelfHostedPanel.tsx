import {
  Check,
  FolderOpen,
  LoaderCircle,
  Play,
  RotateCcw,
  Save,
  Server,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MenuSelect, type MenuOption } from "../../MenuSelect";
import type {
  HostConfig,
  MobileRelayV2SelfHostedStatus,
} from "../../platform";
import { useDashboardBackend } from "../../platform";
import {
  createRelayV2SelfHostedPanelController,
  type RelayV2SelfHostedOperation,
  type RelayV2SelfHostedPanelController,
} from "./relayV2SelfHostedPanelController";
import {
  createRelayV2SelfHostedDraft,
  relayV2ExpiredBootstrapRotationAvailable,
  relayV2SelfHostedDraftMatchesStatus,
  relayV2SelfHostedStatusLabel,
  type RelayV2SelfHostedDraft,
  type RelayV2SelfHostedDraftErrors,
} from "./relayV2SelfHostedModel";

type Operation = RelayV2SelfHostedOperation;

// Behavior shell note: all mount-probe/edit/run fence wiring lives in
// createRelayV2SelfHostedPanelController (relayV2SelfHostedPanelController.ts),
// which has node-drivable regression tests for the C035 stale-response race
// (tests/relayV2SelfHostedPanelGate.test.ts). This component only forwards
// mount/unmount/update/run to that controller and mirrors its state; the
// forwarding itself is covered by typecheck and the SSR render smoke test
// (the repo has no jsdom/react-test-renderer, so effects can't run in tests).
export function RelayV2SelfHostedPanel({ hosts }: { hosts: readonly HostConfig[] }) {
  const backend = useDashboardBackend();
  const [controller] = useState<RelayV2SelfHostedPanelController>(() =>
    createRelayV2SelfHostedPanelController(backend.relay.v2Deployment, (next) => {
      setDraft(next.draft);
      setStatus(next.status);
      setErrors(next.errors);
      setOperation(next.operation);
      setNotice(next.notice);
    }),
  );
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
    controller.mount();
    return () => controller.unmount();
  }, [controller]);

  const update = <K extends keyof RelayV2SelfHostedDraft>(
    field: K,
    value: RelayV2SelfHostedDraft[K],
  ) => {
    controller.update(field, value);
  };

  const run = (kind: Exclude<Operation, null>) => {
    void controller.run(kind);
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
  const rotationAvailable = relayV2ExpiredBootstrapRotationAvailable(status);
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
            Requires Linux x86_64, Node.js 22.16+, and an ext-family filesystem.
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
        <label className="connections-relay-v2-deployment__toggle">
          <input
            type="checkbox"
            checked={draft.externalTlsManagement}
            disabled={locked || running || !draft.enabled}
            onChange={(event) => update("externalTlsManagement", event.target.checked)}
          />
          TLS is externally managed (Let&apos;s Encrypt)
        </label>
        {draft.externalTlsManagement && (
          <p className="connections-relay-v2-deployment__hint">
            TLS is managed outside the Dashboard (for example, Let&apos;s Encrypt
            auto-renewal on the devbox). Deploy validates the certificate in
            place and never generates or overwrites the remote TLS files.
          </p>
        )}
        <DeploymentFileField
          label="Local TLS private key"
          value={draft.tlsKeyPath}
          error={errors.tlsKeyPath}
          disabled={locked || running || !draft.enabled || draft.externalTlsManagement}
          onChoose={() => void selectFile("tlsKeyPath")}
        />
        <DeploymentFileField
          label="Local TLS leaf certificate"
          value={draft.tlsCertificatePath}
          error={errors.tlsCertificatePath}
          disabled={locked || running || !draft.enabled || draft.externalTlsManagement}
          onChoose={() => void selectFile("tlsCertificatePath")}
        />
        <DeploymentFileField
          label="Local TLS CA certificate"
          value={draft.tlsCaPath}
          error={errors.tlsCaPath}
          disabled={locked || running || !draft.enabled || draft.externalTlsManagement}
          onChoose={() => void selectFile("tlsCaPath")}
        />
      </div>

      {status?.configured && (
        <div className="connections-relay-v2-deployment__facts">
          <span>Bundle · {status.bundleStatus}</span>
          <span>TLS/profile · {status.tlsStatus}</span>
          <span>Center · {status.centerStatus}</span>
          <span>
            Host bootstrap · {status.hostCredentialProvisioned
              ? "credential provisioned"
              : status.bootstrapRotationPending
                ? "rotation pending"
                : status.hostBootstrapAvailable
                  ? "0600 file ready"
                  : status.hostBootstrapPending
                    ? "local input missing"
                    : "not created"}
          </span>
          <span>
            Stack · {status.effective
              ? "v2 primary"
              : "v1 default"}
          </span>
          <span>
            Connector desired · {status.connectorDesiredRunning ? "running" : "stopped"}
          </span>
        </div>
      )}
      <p className="connections-relay-v2-deployment__hint">
        Enter the devbox&apos;s private IPv4 explicitly. Using 0.0.0.0 is an
        explicit opt-in to listen on every interface.{" "}
        {draft.externalTlsManagement
          ? "Deployment validates the devbox&apos;s existing TLS certificate (SAN matches the HTTPS Relay URL, not expired) and never generates or overwrites the remote TLS files. The public chain is pulled back locally for the management Host."
          : "TLS key, leaf certificate, and CA certificate must be current-user-owned, single-link, exact 0600 files. Deployment publishes separate 0600 copies and keeps the Broker SQLite state directory 0700."}
      </p>
      <p className="connections-relay-v2-deployment__hint">
        Manual recovery only: rotate only when the Host native credential cell is
        still version 0 pending and its bootstrap has expired. Dashboard never
        guesses expiry. Rotation preserves the Broker SQLite state, Host cell, and
        bootstrap correlation.
        {status?.bootstrapRotationPending
          ? " A rotation is pending; retry continues the same correlation."
          : ""}
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
        <button
          type="button"
          className="connections-button"
          disabled={locked || !draftMatchesSaved || !rotationAvailable}
          onClick={() => void run("rotate")}
        >
          {operation === "rotate"
            ? <LoaderCircle className="connections-spin" size={14} />
            : <RotateCcw size={14} />}
          Rotate expired Host bootstrap
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
