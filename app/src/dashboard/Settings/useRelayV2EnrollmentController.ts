import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useDashboardBackend } from "../../platform";
import type {
  MobileRelayV2DashboardState,
  MobileRelayV2EnrollmentArtifactCopyField,
  MobileRelayV2OperationFailure,
} from "../../platform/domainTypes";
import {
  classifyMobileRelayV2OperationFailure,
  normalizeMobileRelayV2DashboardState,
} from "../../platform/relayV2Domain";
import {
  createRelayV2EnrollmentState,
  relayV2EnrollmentReducer,
  type RelayV2EnrollmentState,
} from "./relayV2EnrollmentModel";
import {
  createRelayV2StatusObserver,
  type RelayV2StatusObserver,
} from "./relayV2StatusObserver";

type RelayV2Operation =
  | "bootstrap"
  | "refresh"
  | "connector-start"
  | "connector-stop"
  | "enrollment-create"
  | "enrollment-retry"
  | "enrollment-rebuild"
  | "grant-revoke";

type ActiveRelayV2Operation = {
  kind: RelayV2Operation;
  requestEpoch: number;
};

function rendererState(state: MobileRelayV2DashboardState): RelayV2EnrollmentState {
  return normalizeMobileRelayV2DashboardState(state);
}

export function useRelayV2EnrollmentController() {
  const backend = useDashboardBackend();
  const [state, dispatch] = useReducer(
    relayV2EnrollmentReducer,
    createRelayV2EnrollmentState(),
  );
  const [loaded, setLoaded] = useState(false);
  const [artifactNotice, setArtifactNotice] = useState<string | null>(null);
  const activeArtifactHandleRef = useRef<string | null>(null);
  const operationRef = useRef<ActiveRelayV2Operation | null>(null);
  const requestEpochRef = useRef(0);
  const observerRef = useRef<RelayV2StatusObserver | null>(null);

  const publish = useCallback((next: MobileRelayV2DashboardState) => {
    dispatch({
      type: "backendStateObserved",
      state: rendererState(next),
    });
  }, []);

  const refresh = useCallback(() => observerRef.current?.refresh(), []);

  useEffect(() => {
    const requestEpoch = ++requestEpochRef.current;
    setLoaded(false);
    operationRef.current = null;
    const observer = createRelayV2StatusObserver({
      read: (signal) => backend.relay.v2.status(signal),
      publish: (next) => {
        if (requestEpoch !== requestEpochRef.current) return;
        publish(next);
        setLoaded(true);
      },
      onError: (failure) => {
        if (requestEpoch !== requestEpochRef.current) return;
        dispatch({ type: "backendObservationFailed", failure });
        setLoaded(true);
      },
      clock: {
        now: Date.now,
        setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clearTimeout: (id) => window.clearTimeout(id as number),
      },
    });
    observerRef.current = observer;
    observer.start();
    return () => {
      observer.stop();
      if (observerRef.current === observer) observerRef.current = null;
      requestEpochRef.current += 1;
      operationRef.current = null;
    };
  }, [backend, publish]);

  const activeArtifactHandle = state.enrollment.status === "active"
    ? state.enrollment.review.renderArtifact.handle
    : null;
  useEffect(() => {
    activeArtifactHandleRef.current = activeArtifactHandle;
    setArtifactNotice(null);
  }, [activeArtifactHandle]);

  const run = useCallback(async (
    operation: RelayV2Operation,
    action: () => Promise<MobileRelayV2DashboardState>,
    start: () => void,
    fail: (failure: MobileRelayV2OperationFailure) => void,
  ): Promise<MobileRelayV2DashboardState | void> => {
    if (operationRef.current) return;
    const requestEpoch = requestEpochRef.current;
    const activeOperation = { kind: operation, requestEpoch };
    operationRef.current = activeOperation;
    observerRef.current?.pause();
    start();
    try {
      const next = await action();
      if (requestEpoch === requestEpochRef.current) {
        publish(next);
        return next;
      }
      return undefined;
    } catch (error) {
      if (requestEpoch === requestEpochRef.current) {
        fail(classifyMobileRelayV2OperationFailure(error));
      }
      return undefined;
    } finally {
      if (operationRef.current === activeOperation) {
        operationRef.current = null;
        observerRef.current?.resume();
      }
    }
  }, [publish]);

  const bootstrapHost = useCallback(() => run(
    "bootstrap",
    () => backend.relay.v2.bootstrapHost(),
    () => dispatch({ type: "hostCredentialOperationStarted", operation: "bootstrap" }),
    (failure) => dispatch({
      type: "hostCredentialOperationFailed",
      error: failure.message,
      retryable: failure.retryable,
    }),
  ), [backend, run]);

  const refreshHost = useCallback(() => run(
    "refresh",
    () => backend.relay.v2.refreshHost(),
    () => dispatch({ type: "hostCredentialOperationStarted", operation: "refresh" }),
    (failure) => dispatch({
      type: "hostCredentialOperationFailed",
      error: failure.message,
      retryable: failure.retryable,
    }),
  ), [backend, run]);

  const startConnector = useCallback(() => run(
    "connector-start",
    () => backend.relay.v2.startConnector(),
    () => dispatch({ type: "connectorStarting" }),
    (failure) => dispatch({
      type: "hostRegistrationLost",
      error: failure.message,
      retryable: failure.retryable,
    }),
  ), [backend, run]);

  const stopConnector = useCallback(() => run(
    "connector-stop",
    () => backend.relay.v2.stopConnector(),
    () => undefined,
    (failure) => dispatch({
      type: "hostRegistrationLost",
      error: failure.message,
      retryable: failure.retryable,
    }),
  ), [backend, run]);

  const createEnrollment = useCallback((intent: "create" | "retry" | "rebuild") => run(
    `enrollment-${intent}`,
    () => backend.relay.v2.createEnrollment({ intent }),
    () => dispatch({ type: "enrollmentCreateStarted", intent }),
    (failure) => dispatch({
      type: "enrollmentCreateFailed",
      intent,
      error: failure.message,
      retryable: failure.retryable,
    }),
  ), [backend, run]);

  const revokeClientGrant = useCallback((grantId: string) => {
    const retryingFailure = state.knownClientGrant.status === "failed"
      && state.knownClientGrant.grantId === grantId
      && state.knownClientGrant.retryable;
    if (!retryingFailure
      && !state.connectedMobileDevices.some((device) => device.grantId === grantId)) {
      return Promise.resolve();
    }
    return run(
      "grant-revoke",
      () => backend.relay.v2.revokeClientGrant({ grantId, reason: "user_revoked" }),
      () => dispatch({ type: "clientGrantRevokeStarted", grantId }),
      (failure) => dispatch({
        type: "clientGrantRevokeFailed",
        grantId,
        error: failure.message,
        retryable: failure.retryable,
      }),
    );
  }, [backend, run, state.connectedMobileDevices, state.knownClientGrant]);

  const showEnrollmentArtifact = useCallback((handle: string) => {
    void backend.relay.v2.showEnrollmentArtifact({ handle }).catch(() => {
      observerRef.current?.refresh();
    });
  }, [backend]);

  const copyEnrollmentArtifact = useCallback((
    handle: string,
    field: MobileRelayV2EnrollmentArtifactCopyField,
  ) => {
    setArtifactNotice(null);
    const requestEpoch = requestEpochRef.current;
    void backend.relay.v2.copyEnrollmentArtifact({ handle, field }).then(() => {
      if (
        requestEpoch !== requestEpochRef.current
        || activeArtifactHandleRef.current !== handle
      ) return;
      setArtifactNotice(field === "enrollment_link"
        ? "One-time enrollment link copied. Paste it into Android pairing before it expires."
        : field === "issuer_url"
          ? "Issuer URL copied."
          : "Relay URL copied.");
    }).catch(() => {
      if (
        requestEpoch !== requestEpochRef.current
        || activeArtifactHandleRef.current !== handle
      ) return;
      setArtifactNotice("The current enrollment value could not be copied. Create a fresh enrollment and try again.");
      observerRef.current?.refresh();
    });
  }, [backend]);

  return {
    state,
    loaded,
    refresh,
    bootstrapHost,
    refreshHost,
    startConnector,
    stopConnector,
    createEnrollment,
    showEnrollmentArtifact,
    copyEnrollmentArtifact,
    artifactNotice,
    revokeClientGrant,
  };
}
