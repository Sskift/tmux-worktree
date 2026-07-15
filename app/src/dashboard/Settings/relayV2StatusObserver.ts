import type {
  MobileRelayV2DashboardState,
  MobileRelayV2OperationFailure,
} from "../../platform/domainTypes";
import {
  classifyMobileRelayV2OperationFailure,
  normalizeMobileRelayV2DashboardState,
} from "../../platform/relayV2Domain";

export const RELAY_V2_STATUS_POLL_INTERVAL_MS = 2_000;

export type RelayV2StatusObserverClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
};

export type RelayV2StatusObserver = {
  start(): void;
  pause(): void;
  resume(): void;
  refresh(): void;
  stop(): void;
};

type RelayV2StatusObserverOptions = {
  read(signal: AbortSignal): Promise<MobileRelayV2DashboardState>;
  publish(state: MobileRelayV2DashboardState): void;
  onError(failure: MobileRelayV2OperationFailure): void;
  clock: RelayV2StatusObserverClock;
  intervalMs?: number;
};

function nextObservationDelay(
  state: MobileRelayV2DashboardState,
  nowMs: number,
  intervalMs: number,
): number {
  if (state.enrollment.status !== "active") return intervalMs;
  return Math.max(
    1,
    Math.min(intervalMs, state.enrollment.review.enrollment.expiresAtMs - nowMs),
  );
}

/**
 * Serializes authoritative status reads. Cancellation invalidates publication
 * immediately; if an adapter ignores AbortSignal, its promise must still settle
 * before another read begins, so native status calls never overlap.
 */
export function createRelayV2StatusObserver(
  options: RelayV2StatusObserverOptions,
): RelayV2StatusObserver {
  const intervalMs = Math.max(1, options.intervalMs ?? RELAY_V2_STATUS_POLL_INTERVAL_MS);
  let active = false;
  let paused = false;
  let generation = 0;
  let timeout: unknown = null;
  let inFlight: { generation: number; abort: AbortController } | null = null;
  let immediateRequested = false;
  let scheduledDelayMs = intervalMs;

  const clearScheduled = () => {
    if (timeout === null) return;
    options.clock.clearTimeout(timeout);
    timeout = null;
  };

  const schedule = (delayMs: number) => {
    if (!active || paused || inFlight) return;
    clearScheduled();
    timeout = options.clock.setTimeout(() => {
      timeout = null;
      immediateRequested = true;
      runIfPossible();
    }, delayMs);
  };

  const runIfPossible = () => {
    if (!active || paused || !immediateRequested || inFlight) return;
    clearScheduled();
    immediateRequested = false;
    const request = {
      generation,
      abort: new AbortController(),
    };
    inFlight = request;
    scheduledDelayMs = intervalMs;
    void Promise.resolve()
      .then(() => options.read(request.abort.signal))
      .then((observed) => {
        if (
          !active
          || paused
          || request.abort.signal.aborted
          || request.generation !== generation
        ) return;
        const nowMs = options.clock.now();
        const normalized = normalizeMobileRelayV2DashboardState(observed, nowMs);
        scheduledDelayMs = nextObservationDelay(normalized, nowMs, intervalMs);
        options.publish(normalized);
      })
      .catch((error) => {
        if (
          !active
          || paused
          || request.abort.signal.aborted
          || request.generation !== generation
        ) return;
        options.onError(classifyMobileRelayV2OperationFailure(error));
      })
      .finally(() => {
        if (inFlight !== request) return;
        inFlight = null;
        if (!active || paused) return;
        if (immediateRequested || request.generation !== generation) runIfPossible();
        else schedule(scheduledDelayMs);
      });
  };

  const invalidate = (requestImmediate: boolean) => {
    generation += 1;
    clearScheduled();
    immediateRequested = requestImmediate;
    inFlight?.abort.abort();
    runIfPossible();
  };

  return {
    start() {
      if (active) return;
      active = true;
      paused = false;
      invalidate(true);
    },
    pause() {
      if (!active || paused) return;
      paused = true;
      invalidate(false);
    },
    resume() {
      if (!active || !paused) return;
      paused = false;
      invalidate(true);
    },
    refresh() {
      if (!active || paused) return;
      invalidate(true);
    },
    stop() {
      if (!active) return;
      active = false;
      paused = false;
      invalidate(false);
    },
  };
}
