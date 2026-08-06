import { AlertCircle, Clipboard, QrCode } from "lucide-react";
import type { MobileRelayV2EnrollmentArtifactCopyField } from "../../platform";
import {
  deriveRelayV2EnrollmentView,
  type RelayV2EnrollmentState,
} from "./relayV2EnrollmentModel";

export function RelayV2EnrollmentPreviewPanel({
  state,
  v1SharedSecretConfigured,
  onBootstrapHost,
  onRefreshHost,
  onStartConnector,
  onStopConnector,
  onCreateEnrollment,
  onShowEnrollmentArtifact,
  onCopyEnrollmentArtifact,
  artifactNotice,
  onRevokeKnownGrant,
}: {
  state?: RelayV2EnrollmentState;
  v1SharedSecretConfigured: boolean;
  onBootstrapHost?: () => void;
  onRefreshHost?: () => void;
  onStartConnector?: () => void;
  onStopConnector?: () => void;
  onCreateEnrollment?: (intent: "create" | "retry" | "rebuild") => void;
  onShowEnrollmentArtifact?: (handle: string) => void;
  onCopyEnrollmentArtifact?: (
    handle: string,
    field: MobileRelayV2EnrollmentArtifactCopyField,
  ) => void;
  artifactNotice?: string | null;
  onRevokeKnownGrant?: () => void;
}) {
  if (!state) return null;

  const view = deriveRelayV2EnrollmentView({
    ...state,
    v1Profile: {
      ...state.v1Profile,
      sharedSecretConfigured: v1SharedSecretConfigured,
    },
  });

  return (
    <div className="connections-relay-v2-preview" aria-label="Relay v2 enrollment preview">
      <div className="connections-relay-pairing connections-relay-pairing--v2">
        <div className="connections-relay-pairing__copy">
          <span className="connections-relay-pairing__icon">
            <QrCode aria-hidden="true" size={17} />
          </span>
          <div>
            <strong>{view.readinessLabel}</strong>
            <span>{view.readinessDetail}</span>
            <span>{view.v1CredentialLabel}. {view.v2CredentialLabel}.</span>
            {view.previewOnly && (
              <span>
                Fake-backed preview only: no credential was issued or exchanged, and no phone
                connection was established.
              </span>
            )}
          </div>
        </div>
        <div className="connections-relay-v2-preview__actions">
          {view.hostCredentialAction && (
            <button
              type="button"
              className="connections-button"
              onClick={view.hostCredentialAction === "bootstrap" ? onBootstrapHost : onRefreshHost}
            >
              {view.hostCredentialAction === "bootstrap"
                ? "Bootstrap local v2 Host"
                : "Refresh local v2 Host"}
            </button>
          )}
          {view.connectorAction && (
            <button
              type="button"
              className="connections-button"
              onClick={view.connectorAction === "stop" ? onStopConnector : onStartConnector}
            >
              {view.connectorAction === "restart"
                ? "Restart local v2 Host"
                : view.connectorAction === "start"
                  ? "Start local v2 Host"
                  : "Stop local v2 Host"}
            </button>
          )}
        </div>
        {view.qrArtifact && view.review ? (
          <div className="connections-relay-v2-preview__review">
            <div className="connections-relay-v2-preview__facts">
              <strong>One-time enrollment review</strong>
              <EnrollmentCopyFact
                label="Issuer URL"
                value={view.review.display.issuerUrl}
                disabled={view.previewOnly}
                onCopy={() => onCopyEnrollmentArtifact?.(
                  view.qrArtifact!.handle,
                  "issuer_url",
                )}
              />
              <EnrollmentCopyFact
                label="Relay URL"
                value={view.review.display.relayUrl}
                disabled={view.previewOnly}
                onCopy={() => onCopyEnrollmentArtifact?.(
                  view.qrArtifact!.handle,
                  "relay_url",
                )}
              />
              <span>Host · {view.review.display.hostId}</span>
              <span>Expires · {new Date(view.review.enrollment.expiresAtMs).toLocaleString()}</span>
            </div>
            <div className="connections-relay-v2-preview__artifact-actions">
              <button
                type="button"
                className="connections-button"
                disabled={view.previewOnly}
                onClick={() => onCopyEnrollmentArtifact?.(
                  view.qrArtifact!.handle,
                  "enrollment_link",
                )}
              >
                {view.previewOnly
                  ? "Native copy unavailable in browser preview"
                  : "Copy one-time link"}
              </button>
              <button
                type="button"
                className="connections-button"
                disabled={view.previewOnly}
                onClick={() => onShowEnrollmentArtifact?.(view.qrArtifact!.handle)}
              >
                {view.previewOnly ? "Native QR unavailable in browser preview" : "Show QR code"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="connections-button"
            disabled={view.enrollmentActionDisabled}
            onClick={() => {
              if (view.enrollmentAction) onCreateEnrollment?.(view.enrollmentAction);
            }}
          >
            {view.enrollmentActionLabel}
          </button>
        )}
        {artifactNotice && (
          <div className="connections-notice connections-notice--pending" role="status">
            <span>{artifactNotice}</span>
          </div>
        )}
        {(state.knownClientGrant.status === "active"
          || state.knownClientGrant.status === "failed"
          || state.knownClientGrant.status === "revoking") && (
          <div className="connections-relay-v2-preview__review">
            <div>
              <strong>Known Android grant</strong>
              <span>{state.knownClientGrant.grantId}</span>
              <span>Status · {state.knownClientGrant.status}</span>
            </div>
            <button
              type="button"
              className="connections-button connections-button--danger"
              disabled={view.grantRevokeDisabled}
              onClick={onRevokeKnownGrant}
            >
              {view.grantRevokeLabel}
            </button>
          </div>
        )}
      </div>
      {view.error && (
        <div className="connections-notice connections-notice--error" role="status">
          <AlertCircle aria-hidden="true" size={15} />
          <span>{view.error}</span>
        </div>
      )}
    </div>
  );
}

function EnrollmentCopyFact({
  label,
  value,
  disabled,
  onCopy,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="connections-relay-v2-preview__fact">
      <span title={value}>{label} · {value}</span>
      <button
        type="button"
        className="connections-icon-button"
        aria-label={`Copy ${label}`}
        disabled={disabled}
        onClick={onCopy}
      >
        <Clipboard aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
