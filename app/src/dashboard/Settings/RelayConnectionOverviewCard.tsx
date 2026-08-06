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
import type {
  RelayConnectionOverview,
  RelayConnectionOverviewPrimaryAction,
} from "./relayConnectionOverviewModel";

export interface RelayConnectionOverviewCardProps {
  overview: RelayConnectionOverview;
  activeReview: { expiresAtMs: number; handle: string } | null;
  knownGrantActive: boolean;
  revokingGrant: boolean;
  qrBusy: boolean;
  copiedEnrollmentLink: boolean;
  onPrimaryAction: (action: RelayConnectionOverviewPrimaryAction) => void;
  onCopyEnrollmentLink: (handle: string) => void;
  onRevokeKnownGrant: () => void;
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
  knownGrantActive,
  revokingGrant,
  qrBusy,
  copiedEnrollmentLink,
  onPrimaryAction,
  onCopyEnrollmentLink,
  onRevokeKnownGrant,
}: RelayConnectionOverviewCardProps) {
  const action = overview.primaryAction;
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

      {(knownGrantActive || revokingGrant) && (
        <div className="connections-relay-overview__paired">
          <span>
            <Smartphone aria-hidden="true" size={14} />
            Paired phone · {revokingGrant ? "revoking…" : "active"}
          </span>
          <button
            type="button"
            className="connections-button connections-button--danger-quiet"
            disabled={revokingGrant}
            onClick={onRevokeKnownGrant}
          >
            {revokingGrant && (
              <LoaderCircle className="connections-spin" aria-hidden="true" size={14} />
            )}
            {revokingGrant ? "Revoking" : "Revoke"}
          </button>
        </div>
      )}
    </section>
  );
}
