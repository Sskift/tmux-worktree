import {
  AlertCircle,
  Check,
  Clipboard,
  LoaderCircle,
  QrCode,
  Radio,
  RotateCcw,
  Settings2,
  Smartphone,
  Wifi,
} from "lucide-react";
import type { ReactNode } from "react";
import type { MobileRelayV2ConnectedDevice } from "../../platform/domainTypes";
import type {
  RelayConnectionOverview,
  RelayConnectionOverviewPrimaryAction,
} from "./relayConnectionOverviewModel";

export interface RelayConnectionOverviewCardProps {
  overview: RelayConnectionOverview;
  activeReview: { expiresAtMs: number; handle: string } | null;
  connectedMobileDevices: readonly MobileRelayV2ConnectedDevice[];
  revokingGrantId: string | null;
  mobileDeviceObservationAvailable: boolean;
  qrBusy: boolean;
  copiedEnrollmentLink: boolean;
  inlineQr: { handle: string; pngBase64: string } | null;
  onPrimaryAction: (action: RelayConnectionOverviewPrimaryAction) => void;
  onCopyEnrollmentLink: (handle: string) => void;
  onRevokeClientGrant: (grantId: string) => void;
  onHidePairingQr: () => void;
}

function compactIdentifier(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-5)}`;
}

function OverviewIcon({ tone }: { tone: RelayConnectionOverview["tone"] }): ReactNode {
  if (tone === "success") return <Wifi aria-hidden="true" size={18} />;
  if (tone === "progress") {
    return <LoaderCircle className="connections-spin" aria-hidden="true" size={18} />;
  }
  if (tone === "danger") return <AlertCircle aria-hidden="true" size={18} />;
  if (tone === "warning") return <Radio aria-hidden="true" size={18} />;
  return <Settings2 aria-hidden="true" size={18} />;
}

/**
 * The one-glance Relay status card: tone + headline + at most one primary
 * button, plus a compact "pairing code" row and a paired-phone row.
 */
export function RelayConnectionOverviewCard({
  overview,
  activeReview,
  connectedMobileDevices,
  revokingGrantId,
  mobileDeviceObservationAvailable,
  qrBusy,
  copiedEnrollmentLink,
  inlineQr,
  onPrimaryAction,
  onCopyEnrollmentLink,
  onRevokeClientGrant,
  onHidePairingQr,
}: RelayConnectionOverviewCardProps) {
  // While the inline QR is expanded, the "Show pairing QR" button would do
  // nothing new — the Hide affordance replaces it until collapsed.
  const action = overview.primaryAction?.kind === "show_qr" && inlineQr
    ? null
    : overview.primaryAction;
  return (
    <section
      className={`connections-card connections-relay-overview connections-relay-overview--${overview.tone}`}
      aria-label="Relay status"
    >
      <div className="connections-relay-overview__main">
        <span className="connections-relay-overview__icon">
          <OverviewIcon tone={overview.tone} />
        </span>
        <div className="connections-relay-overview__copy">
          <strong className="connections-relay-overview__headline">
            {overview.headline}
          </strong>
          {overview.detail && (
            <span className="connections-relay-overview__detail">{overview.detail}</span>
          )}
        </div>
        {action && (
          <button
            type="button"
            className="connections-button connections-button--primary"
            disabled={qrBusy}
            onClick={() => onPrimaryAction(action)}
          >
            {action.kind === "show_qr" ? (
              qrBusy
                ? <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                : <QrCode aria-hidden="true" size={14} />
            ) : action.kind === "fix" ? (
              <RotateCcw aria-hidden="true" size={14} />
            ) : (
              <Settings2 aria-hidden="true" size={14} />
            )}
            {action.kind === "show_qr" && qrBusy ? "Creating…" : action.label}
          </button>
        )}
      </div>

      {inlineQr && (
        <div className="connections-relay-overview__qr">
          <img
            src={`data:image/png;base64,${inlineQr.pngBase64}`}
            alt="Pairing QR code"
            className="connections-relay-overview__qr-image"
            width={220}
            height={220}
          />
          <button
            type="button"
            className="connections-relay-overview__qr-hide"
            onClick={onHidePairingQr}
          >
            Hide
          </button>
        </div>
      )}

      {activeReview && (
        <div className="connections-relay-overview__secondary">
          <span>
            Pairing code expires {new Date(activeReview.expiresAtMs).toLocaleString()}
          </span>
          <button
            type="button"
            className="connections-button"
            onClick={() => onCopyEnrollmentLink(activeReview.handle)}
          >
            {copiedEnrollmentLink
              ? <Check aria-hidden="true" size={14} />
              : <Clipboard aria-hidden="true" size={14} />}
            {copiedEnrollmentLink ? "Copied" : "Copy one-time link"}
          </button>
        </div>
      )}

      {mobileDeviceObservationAvailable && (
        <div className="connections-relay-overview__devices">
          <div className="connections-relay-overview__devices-heading">
            <span>Connected mobile devices</span>
            <strong>{connectedMobileDevices.length}</strong>
          </div>
          {connectedMobileDevices.length === 0 ? (
            <span className="connections-relay-overview__devices-empty">
              No mobile device is currently connected.
            </span>
          ) : connectedMobileDevices.map((device) => {
            const revoking = revokingGrantId === device.grantId;
            return (
              <div className="connections-relay-overview__device" key={device.grantId}>
                <span className="connections-relay-overview__device-icon">
                  <Smartphone aria-hidden="true" size={14} />
                </span>
                <div className="connections-relay-overview__device-copy">
                  <strong>Mobile device · Connected</strong>
                  <span title={device.clientInstanceId}>
                    Client · {compactIdentifier(device.clientInstanceId)}
                  </span>
                  <span title={device.grantId}>
                    Grant · {compactIdentifier(device.grantId)} · {device.connectionCount}
                    {device.connectionCount === 1 ? " connection" : " connections"}
                  </span>
                </div>
                <button
                  type="button"
                  className="connections-button connections-button--danger-quiet"
                  disabled={revokingGrantId !== null}
                  onClick={() => onRevokeClientGrant(device.grantId)}
                >
                  {revoking && (
                    <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
                  )}
                  {revoking ? "Revoking" : "Revoke"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
