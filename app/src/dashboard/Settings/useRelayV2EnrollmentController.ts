import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useDashboardBackend } from "../../platform";
import type {
  MobileRelayV2DashboardState,
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

function rendererState(
  state: MobileRelayV2DashboardState,
  sharedSecretConfigured: boolean,
): RelayV2EnrollmentState {
  const normalized = normalizeMobileRelayV2DashboardState(state);
  return {
    ...normalized,
    v1Profile: {
      ...normalized.v1Profile,
      sharedSecretConfigured,
    },
  };
}

export function useRelayV2EnrollmentController(sharedSecretConfigured: boolean) {
  const backend = useDashboardBackend();
  const [state, dispatch] = useReducer(
    relayV2EnrollmentReducer,
    sharedSecretConfigured,
    createRelayV2EnrollmentState,
  );
  const [loaded, setLoaded] = useState(false);
  const operationRef = useRef<ActiveRelayV2Operation | null>(null);
  const requestEpochRef = useRef(0);
  const observerRef = useRef<RelayV2StatusObserver | null>(null);

  const publish = useCallback((next: MobileRelayV2DashboardState) => {
    dispatch({
      type: "backendStateObserved",
      state: rendererState(next, sharedSecretConfigured),
    });
  }, [sharedSecretConfigured]);

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
  }, [backend, publish, sharedSecretConfigured]);

  useEffect(() => {
    dispatch({ type: "v1ProfileObserved", sharedSecretConfigured });
  }, [sharedSecretConfigured]);

  const run = useCallback(async (
    operation: RelayV2Operation,
    action: () => Promise<MobileRelayV2DashboardState>,
    start: () => void,
    fail: (failure: MobileRelayV2OperationFailure) => void,
  ) => {
    if (operationRef.current) return;
    const requestEpoch = requestEpochRef.current;
    const activeOperation = { kind: operation, requestEpoch };
    operationRef.current = activeOperation;
    observerRef.current?.pause();
    start();
    try {
      const next = await action();
      if (requestEpoch === requestEpochRef.current) publish(next);
    } catch (error) {
      if (requestEpoch === requestEpochRef.current) {
        fail(classifyMobileRelayV2OperationFailure(error));
      }
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

  const revokeKnownGrant = useCallback(() => {
    if (
      state.knownClientGrant.status !== "active"
      && !(
        state.knownClientGrant.status === "failed"
        && state.knownClientGrant.retryable
      )
    ) return Promise.resolve();
    const { grantId } = state.knownClientGrant;
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
  }, [backend, run, state.knownClientGrant]);

  return {
    state,
    loaded,
    refresh,
    bootstrapHost,
    refreshHost,
    startConnector,
    stopConnector,
    createEnrollment,
    revokeKnownGrant,
  };
}
