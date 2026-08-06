import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboardBackend } from "../../platform";
import type { MobileRelayV2SelfHostedStatus } from "../../platform/domainTypes";
import {
  deriveRelayConnectionOverview,
  type RelayConnectionOverview,
} from "./relayConnectionOverviewModel";
import { deriveRelayV2EnrollmentView } from "./relayV2EnrollmentModel";
import type { useRelayV2EnrollmentController } from "./useRelayV2EnrollmentController";

/** How long a "Fix connection" run may wait for the connector to register. */
const REPAIR_POLL_TIMEOUT_MS = 30_000;

type RelayController = ReturnType<typeof useRelayV2EnrollmentController>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Composes the existing Relay v2 management controller with the self-hosted
 * deployment status to produce the one-glance overview for the Relay tab.
 *
 * The controller instance is owned by the caller (ConnectionsSettings) so the
 * Advanced enrollment panel shares the same polled state and operations.
 */
export function useRelayConnectionOverview(
  selfHosted: MobileRelayV2SelfHostedStatus | null,
  controller: RelayController,
) {
  const backend = useDashboardBackend();
  const [repair, setRepair] = useState<{ running: boolean; headline: string }>({
    running: false,
    headline: "",
  });
  const [repairError, setRepairError] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [inlineQr, setInlineQr] = useState<{ handle: string; pngBase64: string } | null>(null);
  const repairRunningRef = useRef(false);
  const qrBusyRef = useRef(false);

  const view = useMemo(
    () => (controller.loaded ? deriveRelayV2EnrollmentView(controller.state) : null),
    [controller.loaded, controller.state],
  );

  const knownGrantActive = controller.state.knownClientGrant.status === "active";
  const revokingGrant = controller.state.knownClientGrant.status === "revoking";
  // The derived view normalizes expiry and registration match, so only a
  // currently valid one-time enrollment surfaces as the active review.
  const activeReview = view?.review && view.qrArtifact
    ? {
        expiresAtMs: view.review.enrollment.expiresAtMs,
        handle: view.qrArtifact.handle,
      }
    : null;

  // Drop the cached inline QR whenever the active review disappears or its
  // handle changes (revoke/expiry/supersede all flow through the status poll).
  const activeQrHandle = activeReview?.handle ?? null;
  useEffect(() => {
    setInlineQr((current) => {
      if (!current) return current;
      if (activeQrHandle === null || activeQrHandle !== current.handle) return null;
      return current;
    });
  }, [activeQrHandle]);

  const inFlight = useMemo(() => {
    if (repair.running) return { active: true, headline: repair.headline };
    if (!controller.loaded) return { active: false, headline: "" };
    const s = controller.state;
    if (s.enrollment.status === "creating") {
      return { active: true, headline: "Creating pairing code…" };
    }
    if (s.connector.status === "starting") {
      return { active: true, headline: "Connecting to the relay center…" };
    }
    if (s.hostCredential.status === "bootstrapping" || s.hostCredential.status === "refreshing") {
      return { active: true, headline: "Updating relay credentials…" };
    }
    return { active: false, headline: "" };
  }, [repair.running, repair.headline, controller.loaded, controller.state]);

  const overview = useMemo<RelayConnectionOverview>(() => deriveRelayConnectionOverview({
    selfHosted,
    enrollmentView: view,
    knownGrantActive,
    inFlight,
    repairError,
  }), [selfHosted, view, knownGrantActive, inFlight, repairError]);

  // While a repair is running, watch the polled connector for registration.
  useEffect(() => {
    if (!repair.running) return;
    if (controller.state.connector.status === "registered") {
      repairRunningRef.current = false;
      setRepairError(null);
      setRepair({ running: false, headline: "" });
    }
  }, [repair.running, controller.state.connector.status]);

  // Cap a repair at ~30s.
  useEffect(() => {
    if (!repair.running) return;
    const timer = window.setTimeout(() => {
      repairRunningRef.current = false;
      setRepair({ running: false, headline: "" });
      setRepairError(
        "Relay connection could not be restored. Open Advanced to review the relay settings.",
      );
    }, REPAIR_POLL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [repair.running]);

  /**
   * One-click "Fix connection". Sequences existing commands only:
   *  - center/bundle/TLS not ready → start the center (which respawns the
   *    management child and sends start_connector);
   *  - otherwise refresh an unhealthy host credential, then start the connector.
   * Afterwards the 2s status observer is watched until the connector registers
   * or the 30s timeout fires.
   */
  const runConnectionRepair = useCallback(async () => {
    if (repairRunningRef.current) return;
    repairRunningRef.current = true;
    setRepairError(null);

    const centerReady =
      selfHosted?.centerStatus === "running" || selfHosted?.centerStatus === "ready";
    const bundleReady = selfHosted?.bundleStatus === "ready";
    const tlsReady = selfHosted?.tlsStatus === "ready";
    const needsCenterStart = !centerReady || !bundleReady || !tlsReady;

    try {
      if (needsCenterStart) {
        if (!selfHosted?.config) {
          throw new Error("Relay is not configured.");
        }
        setRepair({ running: true, headline: "Starting relay center…" });
        await backend.relay.v2Deployment.startCenter(selfHosted.config);
      } else {
        setRepair({ running: true, headline: "Connecting to the relay center…" });
        const connectorStatus = controller.state.connector.status;
        if (
          connectorStatus !== "registered"
          && connectorStatus !== "registered_incomplete"
        ) {
          const credential = controller.state.hostCredential;
          if (credential.status !== "ready") {
            if (credential.credentialReference) {
              await controller.refreshHost();
            } else {
              await controller.bootstrapHost();
            }
          }
          await controller.startConnector();
        }
      }
      // The watch effect above clears the repair once the poll sees "registered".
    } catch (error) {
      repairRunningRef.current = false;
      setRepair({ running: false, headline: "" });
      setRepairError(errorMessage(error));
    }
  }, [backend, selfHosted, controller]);

  /**
   * "Show pairing QR": create a fresh enrollment when the current one is missing
   * or expired, then fetch the Rust-generated QR PNG for the fresh artifact
   * handle and render it inline in the overview card.
   */
  const showPairingQr = useCallback(async () => {
    if (qrBusyRef.current) return;
    qrBusyRef.current = true;
    setQrBusy(true);
    setRepairError(null);
    try {
      const currentHandle = view?.qrArtifact?.handle ?? null;
      let handle = currentHandle;
      if (!handle) {
        const next = await controller.createEnrollment("create");
        const freshHandle = next?.enrollment.status === "active"
          ? next.enrollment.review.renderArtifact.handle
          : null;
        if (!freshHandle) {
          setRepairError("A pairing code could not be created. Try again in a moment.");
          return;
        }
        handle = freshHandle;
      }
      const pngBase64 = await backend.relay.v2.inlineEnrollmentArtifactPng({ handle });
      setInlineQr({ handle, pngBase64 });
    } catch (error) {
      setRepairError(errorMessage(error));
    } finally {
      qrBusyRef.current = false;
      setQrBusy(false);
    }
  }, [backend, controller, view]);

  const hidePairingQr = useCallback(() => {
    setInlineQr(null);
  }, []);

  const copyEnrollmentLink = useCallback((handle: string) => {
    controller.copyEnrollmentArtifact(handle, "enrollment_link");
  }, [controller]);

  const revokeKnownGrant = useCallback(() => {
    void controller.revokeKnownGrant();
  }, [controller]);

  return {
    overview,
    activeReview,
    knownGrantActive,
    revokingGrant,
    qrBusy,
    inlineQr,
    runConnectionRepair,
    showPairingQr,
    hidePairingQr,
    copyEnrollmentLink,
    revokeKnownGrant,
  };
}
