import { AlertCircle, QrCode } from "lucide-react";
import {
  deriveRelayV2EnrollmentView,
  type RelayV2EnrollmentState,
} from "./relayV2EnrollmentModel";
import { useRelayV2EnrollmentController } from "./useRelayV2EnrollmentController";

export function RelayV2EnrollmentPanel({
  v1SharedSecretConfigured,
}: {
  v1SharedSecretConfigured: boolean;
}) {
  const controller = useRelayV2EnrollmentController(v1SharedSecretConfigured);
  if (!controller.loaded) return null;
  return (
    <RelayV2EnrollmentPreviewPanel
      state={controller.state}
      v1SharedSecretConfigured={v1SharedSecretConfigured}
      onBootstrapHost={controller.bootstrapHost}
      onRefreshHost={controller.refreshHost}
      onStartConnector={controller.startConnector}
      onStopConnector={controller.stopConnector}
      onCreateEnrollment={controller.createEnrollment}
      onShowEnrollmentArtifact={controller.showEnrollmentArtifact}
      onRevokeKnownGrant={controller.revokeKnownGrant}
    />
  );
}

export function RelayV2EnrollmentPreviewPanel({
  state,
  v1SharedSecretConfigured,
  onBootstrapHost,
  onRefreshHost,
  onStartConnector,
  onStopConnector,
  onCreateEnrollment,
  onShowEnrollmentArtifact,
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
              {view.hostCredentialAction === "bootstrap" ? "Bootstrap v2 host" : "Refresh v2 host"}
            </button>
          )}
          {view.connectorAction && (
            <button
              type="button"
              className="connections-button"
              onClick={view.connectorAction === "stop" ? onStopConnector : onStartConnector}
            >
              {view.connectorAction === "restart"
                ? "Restart v2 connector"
                : view.connectorAction === "start"
                  ? "Start v2 connector"
                  : "Stop v2 connector"}
            </button>
          )}
        </div>
        {view.qrArtifact && view.review ? (
          <div className="connections-relay-v2-preview__review">
            <div>
              <strong>One-time enrollment review</strong>
              <span>{view.review.display.issuerUrl}</span>
              <span>{view.review.display.relayUrl}</span>
              <span>Host · {view.review.display.hostId}</span>
              <span>Expires · {new Date(view.review.enrollment.expiresAtMs).toLocaleString()}</span>
            </div>
            <button
              type="button"
              className="connections-button"
              disabled={view.previewOnly}
              onClick={() => onShowEnrollmentArtifact?.(view.qrArtifact!.handle)}
            >
              {view.previewOnly ? "Native QR unavailable in browser preview" : "Show QR code"}
            </button>
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
        {(state.knownClientGrant.status === "active"
          || state.knownClientGrant.status === "failed"
          || state.knownClientGrant.status === "revoking") && (
          <button
            type="button"
            className="connections-button connections-button--danger"
            disabled={view.grantRevokeDisabled}
            onClick={onRevokeKnownGrant}
          >
            {view.grantRevokeLabel}
          </button>
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
