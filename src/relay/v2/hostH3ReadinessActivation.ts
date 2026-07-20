import type { RelayV2HostCapabilityReadinessSourceSink } from "./hostCapabilityReadiness.js";
import type { RelayV2HostRuntimeActualAuthorityInput } from "./hostRuntime.js";
import {
  captureRelayV2HostH3RecoveryCandidate,
  type RelayV2HostH3RecoveryCandidate,
  type RelayV2HostH3RecoveryCandidateSink,
} from "./terminalDurableLineage.js";
import {
  RelayV2TerminalManagerError,
  type RelayV2TerminalManagerRecoveryBinding,
} from "./terminalManager.js";

export interface RelayV2HostH3ReadinessLifecycle {
  activate(): boolean;
  close(): Promise<void>;
}

export interface RelayV2HostH3ReadinessActivation {
  readonly runtimeH3: RelayV2HostRuntimeActualAuthorityInput["h3"];
  readonly lifecycle: RelayV2HostH3ReadinessLifecycle;
  dispose(): Promise<void>;
}

export interface RelayV2HostH3ReadinessActivationOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  candidate: RelayV2HostH3RecoveryCandidate;
  readinessSink: RelayV2HostCapabilityReadinessSourceSink<"h3">;
}

type H3Method = keyof RelayV2HostRuntimeActualAuthorityInput["h3"];

function unavailable(): RelayV2TerminalManagerError {
  return new RelayV2TerminalManagerError(
    "CAPABILITY_UNAVAILABLE",
    "Relay v2 terminal authority is not recovered and ready",
  );
}

/**
 * Binds one exact durable recovery candidate to the only H3 facade reachable
 * by the host runtime. Readiness withdrawal is synchronous; shutdown remains
 * an idempotent asynchronous barrier behind already accepted manager work.
 */
export function createRelayV2HostH3ReadinessActivation(
  options: RelayV2HostH3ReadinessActivationOptions,
): RelayV2HostH3ReadinessActivation {
  const authority = captureRelayV2HostH3RecoveryCandidate(options.candidate);
  if (authority === null
    || authority.hostId !== options.hostId
    || authority.hostEpoch !== options.hostEpoch
    || authority.hostInstanceId !== options.hostInstanceId) {
    throw new Error("invalid Relay v2 H3 recovery candidate");
  }

  let phase: "idle" | "active" | "closing" | "closed" = "idle";
  let binding: RelayV2TerminalManagerRecoveryBinding | null = null;
  let closeBarrier: Promise<void> | null = null;
  const inFlight = new Set<Promise<void>>();

  const beginClose = (): Promise<void> => {
    if (closeBarrier !== null) return closeBarrier;
    let resolveBarrier: () => void = () => undefined;
    let rejectBarrier: (reason?: unknown) => void = () => undefined;
    const publishedBarrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    closeBarrier = publishedBarrier;
    const closingFromIdle = phase === "idle";
    phase = "closing";
    let retiring = binding;
    binding = null;
    const synchronousFailures: unknown[] = [];
    const rememberFailure = (error: unknown): void => {
      if (synchronousFailures.length === 0) synchronousFailures.push(error);
    };
    if (retiring === null && closingFromIdle) {
      try {
        retiring = authority.consume(candidateSink);
      } catch (error) {
        rememberFailure(error);
      }
    }
    try {
      options.readinessSink.close();
    } catch (error) {
      rememberFailure(error);
    }
    try {
      authority.release(candidateSink);
    } catch (error) {
      rememberFailure(error);
    }
    const accepted = [...inFlight];
    void (async () => {
      const asynchronousFailures: unknown[] = [];
      try {
        await Promise.allSettled(accepted);
        if (retiring !== null) await retiring.manager.shutdown();
      } catch (error) {
        asynchronousFailures.push(error);
      }
      phase = "closed";
      const failures = [...synchronousFailures, ...asynchronousFailures];
      if (failures.length === 0) resolveBarrier();
      else rejectBarrier(failures[0]);
    })();
    return publishedBarrier;
  };

  const candidateSink: RelayV2HostH3RecoveryCandidateSink = Object.freeze({
    close(): void {
      void beginClose().catch(() => undefined);
    },
  });

  const invoke = (method: H3Method, args: readonly unknown[]): Promise<void> => {
    const active = binding;
    if (phase !== "active" || active === null) return Promise.reject(unavailable());
    let pending: Promise<void>;
    try {
      const member = active.manager[method] as (...input: unknown[]) => Promise<void>;
      pending = Reflect.apply(member, active.manager, args);
    } catch (error) {
      void beginClose().catch(() => undefined);
      return Promise.reject(error);
    }
    inFlight.add(pending);
    void pending.then(
      () => { inFlight.delete(pending); },
      () => { inFlight.delete(pending); },
    );
    return pending;
  };

  const runtimeH3: RelayV2HostRuntimeActualAuthorityInput["h3"] = Object.freeze({
    open: (request) => invoke("open", [request]),
    requestReplay: (request) => invoke("requestReplay", [request]),
    acknowledgeOutput: (ack) => invoke("acknowledgeOutput", [ack]),
    input: (input) => invoke("input", [input]),
    resize: (resize) => invoke("resize", [resize]),
    close: (request) => invoke("close", [request]),
    unbind: (auth, route) => invoke("unbind", [auth, route]),
  });

  const lifecycle: RelayV2HostH3ReadinessLifecycle = Object.freeze({
    activate(): boolean {
      if (phase === "active") return true;
      if (phase !== "idle") return false;
      const consumed = authority.consume(candidateSink);
      if (consumed === null) {
        void beginClose().catch(() => undefined);
        return false;
      }
      binding = consumed;
      phase = "active";
      let accepted: unknown;
      try {
        accepted = options.readinessSink.apply({
          source: "h3",
          generation: authority.ownerFence,
          ready: true,
        });
      } catch (error) {
        void beginClose().catch(() => undefined);
        throw error;
      }
      if (accepted !== true || phase !== "active" || binding !== consumed) {
        void beginClose().catch(() => undefined);
        return false;
      }
      return true;
    },
    close: beginClose,
  });

  return Object.freeze({
    runtimeH3,
    lifecycle,
    dispose: beginClose,
  });
}
