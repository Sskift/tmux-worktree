import { AlertCircle, QrCode } from "lucide-react";
import { useEffect, useRef } from "react";
import QRCode from "qrcode";
import {
  deriveRelayV2EnrollmentView,
  type RelayV2EnrollmentState,
} from "./relayV2EnrollmentModel";

export function RelayV2EnrollmentPreviewPanel({
  state,
  v1SharedSecretConfigured,
}: {
  state?: RelayV2EnrollmentState;
  v1SharedSecretConfigured: boolean;
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
            <span>
              Fake-backed preview only: no credential was issued or exchanged, and no phone
              connection was established.
            </span>
          </div>
        </div>
        {view.qrPayload && view.review ? (
          <div className="connections-relay-v2-preview__review">
            <div>
              <strong>One-time enrollment review</strong>
              <span>{view.review.display.issuerUrl}</span>
              <span>{view.review.display.relayUrl}</span>
              <span>Host · {view.review.display.hostId}</span>
            </div>
            <MobileRelayV2EnrollmentQrCode payload={view.qrPayload} />
          </div>
        ) : (
          <button
            type="button"
            className="connections-button"
            disabled={view.enrollmentActionDisabled}
          >
            {view.enrollmentActionLabel}
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

function MobileRelayV2EnrollmentQrCode({ payload }: { payload: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let active = true;
    void QRCode.toCanvas(canvas, payload, {
      width: 132,
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
      aria-label="Relay v2 one-time enrollment preview QR code"
      role="img"
    />
  );
}
